/**
 * DuckDB Query Service
 *
 * Provides fast analytics queries against Parquet files in S3/SeaweedFS.
 * Uses DuckDB CLI for execution (simpler than embedding DuckDB in Node.js).
 */

import {spawn} from 'child_process'

import {getS3Config} from '../s3/s3Client'

export interface DuckDBQueryResult<T> {
  data: T[]
  error?: string
}

/**
 * Execute a DuckDB SQL query against the Parquet files.
 * Returns results as JSON.
 */
export const queryDuckDB = async <T>(sql: string): Promise<DuckDBQueryResult<T>> => {
  const s3Config = getS3Config()

  // Build the full SQL with S3 configuration
  const fullSql = `
INSTALL httpfs;
LOAD httpfs;
SET s3_region = 'us-east-1';
SET s3_access_key_id = '${process.env.S3_ACCESS_KEY || 'admin'}';
SET s3_secret_access_key = '${process.env.S3_SECRET_KEY || 'admin'}';
SET s3_endpoint = '${s3Config.endpoint.replace('http://', '').replace('https://', '')}';
SET s3_use_ssl = ${s3Config.endpoint.startsWith('https') ? 'true' : 'false'};
SET s3_url_style = 'path';

${sql}
`

  return new Promise((resolve) => {
    const duckdb = spawn('duckdb', ['-json', '-c', fullSql], {stdio: ['pipe', 'pipe', 'pipe']})

    let stdout = ''
    let stderr = ''

    duckdb.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })

    duckdb.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    duckdb.on('close', (code) => {
      if (code !== 0) {
        console.error('DuckDB query failed:', stderr)
        resolve({data: [], error: stderr})
        return
      }

      try {
        // DuckDB -json output is an array of objects
        const result = JSON.parse(stdout) as T[]
        resolve({data: result})
      } catch (_parseError) {
        console.error('Failed to parse DuckDB output:', stdout)
        resolve({data: [], error: 'Failed to parse query result'})
      }
    })

    duckdb.on('error', (err) => {
      console.error('DuckDB spawn error:', err)
      resolve({data: [], error: `Failed to run DuckDB: ${err.message}`})
    })
  })
}

/**
 * Get the Parquet files path for judgments.
 */
export const getJudgmentsParquetPath = (): string => {
  const s3Config = getS3Config()
  return `s3://${s3Config.bucket}/judgments/year=*/month=*/*.parquet`
}

/**
 * Escape a string for use in SQL (prevent SQL injection).
 */
export const escapeSqlString = (str: string): string => {
  return str.replace(/'/g, "''")
}

/**
 * Build an IN clause from an array of strings.
 */
export const buildInClause = (values: string[]): string => {
  if (values.length === 0) return "''"
  return values
    .map((v) => {
      return `'${escapeSqlString(v)}'`
    })
    .join(', ')
}
