/**
 * ULTRA-FAST Backfill PostgreSQL judgments to Parquet using DuckDB
 *
 * DuckDB provides native PostgreSQL connection and Parquet writing,
 * which is 10-100x faster than row-by-row processing in Node.js.
 *
 * Prerequisites:
 *   brew install duckdb   (or download from duckdb.org)
 *   brew install awscli   (for S3 upload with multipart support)
 *
 * Usage: bun scripts/backfillPostgresToParquetDuckDB.ts
 *
 * Options (via env vars):
 *   LIMIT=0               - Number of rows to process (default: 0 = ALL)
 *   OUTPUT_DIR=./data/parquet-local  - Where to write Parquet files locally
 *   UPLOAD_TO_S3=true     - Whether to upload to S3 after generation
 *   CLEANUP_LOCAL=true    - Remove local files after successful S3 upload (default: true)
 */

import {spawn} from 'child_process'
import {mkdir, readdir, rm} from 'fs/promises'
import path from 'path'

import {env} from '../src/server/utils/env'
import {ensureBucket, getS3Config} from '../src/services/s3/s3Client'

const LIMIT = parseInt(process.env.LIMIT ?? '0', 10)
const OUTPUT_DIR = process.env.OUTPUT_DIR ?? './data/parquet-local'
const UPLOAD_TO_S3 = process.env.UPLOAD_TO_S3 !== 'false'
const CLEANUP_LOCAL = process.env.CLEANUP_LOCAL !== 'false' // Remove local files after S3 upload

const log = (message: string) => {
  console.log(`[${new Date().toISOString()}] ${message}`)
}

const formatDuration = (seconds: number): string => {
  const hours = Math.floor(seconds / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)
  if (hours > 0) return `${hours}h ${mins}m ${secs}s`
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`
}

/**
 * Run a DuckDB command and stream output
 */
const runDuckDB = (sqlCommands: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    const duckdb = spawn('duckdb', ['-c', sqlCommands], {stdio: ['pipe', 'pipe', 'pipe']})

    duckdb.stdout.on('data', (data: Buffer) => {
      process.stdout.write(data)
    })

    duckdb.stderr.on('data', (data: Buffer) => {
      process.stderr.write(data)
    })

    duckdb.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`DuckDB exited with code ${code}`))
      }
    })

    duckdb.on('error', (err) => {
      reject(new Error(`Failed to start DuckDB: ${err.message}. Is DuckDB installed? Run: brew install duckdb`))
    })
  })
}

/**
 * Upload a single file to S3 using AWS CLI (supports multipart upload for large files)
 */
const uploadFileWithAwsCli = (localPath: string, s3Uri: string, endpoint: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    const awsProcess = spawn(
      'aws',
      ['--endpoint-url', endpoint, 's3', 'cp', localPath, s3Uri, '--content-type', 'application/vnd.apache.parquet'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          AWS_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY || 'admin',
          AWS_SECRET_ACCESS_KEY: process.env.S3_SECRET_KEY || 'admin',
        },
      },
    )

    let stderr = ''
    awsProcess.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    awsProcess.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`AWS CLI upload failed: ${stderr}`))
      }
    })

    awsProcess.on('error', (err) => {
      reject(new Error(`Failed to start AWS CLI: ${err.message}. Is AWS CLI installed? Run: brew install awscli`))
    })
  })
}

/**
 * Upload Parquet files from local directory to S3 using AWS CLI.
 * AWS CLI handles multipart uploads automatically for large files.
 */
const uploadParquetFilesToS3 = async (localDir: string): Promise<string[]> => {
  const s3Config = getS3Config()
  await ensureBucket(s3Config.bucket)

  const uploadedKeys: string[] = []

  // Walk the directory structure
  // Files are uploaded with 'judgments/' prefix to match expected path: judgments/year=YYYY/month=MM/*.parquet
  const walkDir = async (dir: string, prefix = 'judgments') => {
    const entries = await readdir(dir, {withFileTypes: true})

    for (const entry of entries) {
      const localPath = path.join(dir, entry.name)
      const s3Key = prefix ? `${prefix}/${entry.name}` : entry.name

      if (entry.isDirectory()) {
        await walkDir(localPath, s3Key)
      } else if (entry.name.endsWith('.parquet')) {
        const s3Uri = `s3://${s3Config.bucket}/${s3Key}`
        await uploadFileWithAwsCli(localPath, s3Uri, s3Config.endpoint)
        uploadedKeys.push(s3Key)
        log(`  Uploaded: ${s3Uri}`)
      }
    }
  }

  await walkDir(localDir)
  return uploadedKeys
}

const main = async () => {
  log('=== PostgreSQL → Parquet ULTRA-FAST Backfill (DuckDB) ===')
  log(`Configuration:`)
  log(`  LIMIT: ${LIMIT === 0 ? 'ALL' : LIMIT}`)
  log(`  OUTPUT_DIR: ${OUTPUT_DIR}`)
  log(`  UPLOAD_TO_S3: ${UPLOAD_TO_S3}`)

  // Ensure output directory exists
  await mkdir(OUTPUT_DIR, {recursive: true})

  // Parse connection string
  const dbUrl = new URL(env.DATABASE_URL)
  const pgHost = dbUrl.hostname
  const pgPort = dbUrl.port || '5432'
  const pgDatabase = dbUrl.pathname.slice(1)
  const pgUser = dbUrl.username
  const pgPassword = dbUrl.password

  log(`  PG_HOST: ${pgHost}`)
  log(`  PG_DATABASE: ${pgDatabase}`)

  const limitClause = LIMIT > 0 ? `LIMIT ${LIMIT}` : ''

  // Build the DuckDB SQL script
  // This does everything in one efficient pipeline:
  // 1. Install and load postgres extension
  // 2. Query PostgreSQL directly (no intermediate step)
  // 3. Write Parquet files partitioned by year/month
  const duckdbSql = `
-- Install and load extensions
INSTALL postgres;
LOAD postgres;

-- Attach PostgreSQL database
ATTACH 'dbname=${pgDatabase} host=${pgHost} port=${pgPort} user=${pgUser} password=${pgPassword}' AS pg (TYPE POSTGRES, READ_ONLY);

-- Show what we're working with
SELECT COUNT(*) as total_judgments FROM pg.judgments WHERE deleted_at IS NULL;

-- Export to Parquet with Hive partitioning
-- DuckDB handles this in a single optimized operation
COPY (
  SELECT
    j.id::VARCHAR as id,
    j.created_at as "createdAt",
    j.deleted_at as "deletedAt",
    j.article_id::VARCHAR as "articleId",
    COALESCE(j.article_title, a.article_title) as "articleTitle",
    COALESCE(j.article_created_at, a.article_created_at) as "articleCreatedAt",
    COALESCE(j.article_updated_at, a.article_updated_at) as "articleUpdatedAt",
    COALESCE(j.article_created_year, EXTRACT(YEAR FROM a.article_created_at)::INTEGER) as "articleCreatedYear",
    COALESCE(j.article_updated_year, EXTRACT(YEAR FROM a.article_updated_at)::INTEGER) as "articleUpdatedYear",
    COALESCE(j.article_import_route, a.import_route) as "articleImportRoute",
    COALESCE(j.article_imported_by, a.imported_by) as "articleImportedBy",
    j.prompt_id::VARCHAR as "promptId",
    j.model_id::VARCHAR as "modelId",
    COALESCE(j.use_title, true) as "useTitle",
    COALESCE(j.use_abstract, true) as "useAbstract",
    COALESCE(j.use_fulltext, false) as "useFulltext",
    COALESCE(j.use_fulltext_no_images, false) as "useFulltextNoImages",
    j.answered_original as "answeredOriginal",
    j.answered_original_as_array as "answeredOriginalAsArray",
    j.explanation,
    CASE WHEN j.quotes IS NOT NULL THEN j.quotes::VARCHAR ELSE NULL END as quotes,
    -- Partition columns (computed)
    EXTRACT(YEAR FROM j.created_at)::INTEGER as year,
    LPAD(EXTRACT(MONTH FROM j.created_at)::VARCHAR, 2, '0') as month
  FROM pg.judgments j
  LEFT JOIN pg.articles a ON j.article_id = a.id
  WHERE j.deleted_at IS NULL
  ORDER BY j.created_at ASC
  ${limitClause}
)
TO '${OUTPUT_DIR}/judgments'
(FORMAT PARQUET, PARTITION_BY (year, month), COMPRESSION 'snappy', ROW_GROUP_SIZE 100000);

-- Show what was written
SELECT 'Export complete!' as status;
`

  log('')
  log('Starting DuckDB export...')
  const startTime = Date.now()

  try {
    await runDuckDB(duckdbSql)
  } catch (error) {
    console.error('DuckDB export failed:', error)
    process.exit(1)
  }

  const exportTime = (Date.now() - startTime) / 1000
  log(`DuckDB export completed in ${formatDuration(exportTime)}`)

  // Upload to S3 if requested
  if (UPLOAD_TO_S3) {
    log('')
    log('Uploading Parquet files to S3...')
    const uploadStart = Date.now()

    try {
      const judgmentsDir = path.join(OUTPUT_DIR, 'judgments')
      const uploadedFiles = await uploadParquetFilesToS3(judgmentsDir)
      const uploadTime = (Date.now() - uploadStart) / 1000

      log('')
      log('=== Upload Complete ===')
      log(`Uploaded ${uploadedFiles.length} files in ${formatDuration(uploadTime)}`)

      // Cleanup local files after successful upload
      if (CLEANUP_LOCAL) {
        log('')
        log('Cleaning up local Parquet files...')
        await rm(judgmentsDir, {recursive: true, force: true})
        log(`Removed: ${judgmentsDir}`)
      }
    } catch (error) {
      console.error('S3 upload failed:', error)
      log('Files are still available locally at: ' + OUTPUT_DIR)
    }
  }

  // Summary
  const totalTime = (Date.now() - startTime) / 1000
  log('')
  log('=== Backfill Complete ===')
  log(`Total time: ${formatDuration(totalTime)}`)
  log(`Output directory: ${OUTPUT_DIR}/judgments`)
  log('')
  log('To inspect the data:')
  log(`  duckdb -c "SELECT * FROM read_parquet('${OUTPUT_DIR}/judgments/**/*.parquet') LIMIT 10"`)
  log(`  duckdb -c "SELECT COUNT(*) FROM read_parquet('${OUTPUT_DIR}/judgments/**/*.parquet')"`)
}

main().catch((err) => {
  console.error('Backfill failed:', err)
  process.exit(1)
})
