/**
 * Backfill script for denormalized judgment fields
 *
 * This script populates the new denormalized fields in the judgments table:
 * - article_title, article_created_at, article_updated_at
 * - article_created_year, article_updated_year
 * - article_import_route, article_imported_by
 * - project_id (from snapshot_project_id, reviews, or jobs)
 *
 * Usage: bun scripts/backfillJudgmentsDenormalized.ts
 *
 * Options (via env vars):
 *   BATCH_SIZE=50000  - Number of rows per batch
 *   DRY_RUN=true      - Preview without making changes
 *   PHASE=1|2|3|all   - Run specific phase or all (default: all)
 */

import {sql} from 'drizzle-orm'
import {drizzle} from 'drizzle-orm/node-postgres'

import {env} from '../src/server/utils/env.ts'

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE ?? '50000', 10)
const DRY_RUN = process.env.DRY_RUN === 'true'
const PHASE = process.env.PHASE ?? 'all'

const log = (message: string) => {
  return console.log(`[${new Date().toISOString()}] ${message}`)
}

const db = drizzle(env.DATABASE_URL, {logger: false})

/**
 * Phase 1: Backfill article fields from the articles table
 * Joins judgments with articles and copies denormalized fields
 */
const runPhase1ArticleFields = async (db: ReturnType<typeof drizzle>) => {
  log('=== Phase 1: Backfilling article fields ===')

  const countResult = await db.execute<{count: string}>(sql`
    SELECT COUNT(*) as count FROM judgments WHERE article_title IS NULL
  `)
  const totalToUpdate = parseInt(countResult.rows[0]?.count ?? '0', 10)
  log(`Found ${totalToUpdate.toLocaleString()} judgments needing article field backfill`)

  const totalRows = totalToUpdate
  let processedRows = 0
  let batchNumber = 0

  const startTime = Date.now()

  const processBatch = async (): Promise<boolean> => {
    batchNumber++

    const updateQuery = sql`
      WITH batch AS (
        SELECT j.id
        FROM judgments j
        WHERE j.article_title IS NULL
        ORDER BY j.id
        LIMIT ${BATCH_SIZE}
      )
      UPDATE judgments j
      SET
        article_title = a.article_title,
        article_created_at = a.article_created_at,
        article_updated_at = a.article_updated_at,
        article_created_year = EXTRACT(YEAR FROM a.article_created_at)::integer,
        article_updated_year = EXTRACT(YEAR FROM a.article_updated_at)::integer,
        article_import_route = a.import_route,
        article_imported_by = a.imported_by
      FROM articles a, batch b
      WHERE j.id = b.id
        AND j.article_id = a.id
      RETURNING j.id
    `

    const result = DRY_RUN ? {rowCount: Math.min(BATCH_SIZE, totalRows - processedRows)} : await db.execute(updateQuery)

    const updatedCount = result.rowCount ?? 0
    processedRows += updatedCount

    const elapsed = (Date.now() - startTime) / 1000
    const rate = processedRows / elapsed
    const remaining = totalRows - processedRows
    const eta = remaining / rate

    log(
      `  Batch ${batchNumber}: Updated ${updatedCount} rows | `
        + `Progress: ${processedRows.toLocaleString()}/${totalRows.toLocaleString()} (${((processedRows / totalRows) * 100).toFixed(1)}%) | `
        + `Rate: ${rate.toFixed(0)}/s | ETA: ${formatDuration(eta)}`,
    )

    return updatedCount > 0 && processedRows < totalRows
  }

  const loop = async (): Promise<void> => {
    const hasMore = await processBatch()
    return hasMore ? loop() : undefined
  }

  await loop()

  log(
    `Phase 1 complete: Processed ${processedRows.toLocaleString()} rows in ${formatDuration((Date.now() - startTime) / 1000)}`,
  )
}

/**
 * Phase 2: Backfill project_id from snapshot_project_id
 * For ~80% of judgments that have snapshot_project_id populated
 */
const runPhase2ProjectIdFromSnapshot = async (db: ReturnType<typeof drizzle>) => {
  log('=== Phase 2: Backfilling project_id from snapshot_project_id ===')

  const countResult = await db.execute<{count: string}>(sql`
    SELECT COUNT(*) as count FROM judgments
    WHERE project_id IS NULL AND snapshot_project_id IS NOT NULL
  `)
  const totalToUpdate = parseInt(countResult.rows[0]?.count ?? '0', 10)
  log(`Found ${totalToUpdate.toLocaleString()} judgments with snapshot_project_id to copy`)

  const totalRows = totalToUpdate
  let processedRows = 0
  let batchNumber = 0

  const startTime = Date.now()

  const processBatch = async (): Promise<boolean> => {
    batchNumber++

    const updateQuery = sql`
      WITH batch AS (
        SELECT id
        FROM judgments
        WHERE project_id IS NULL AND snapshot_project_id IS NOT NULL
        ORDER BY id
        LIMIT ${BATCH_SIZE}
      )
      UPDATE judgments j
      SET project_id = j.snapshot_project_id
      FROM batch b
      WHERE j.id = b.id
      RETURNING j.id
    `

    const result = DRY_RUN ? {rowCount: Math.min(BATCH_SIZE, totalRows - processedRows)} : await db.execute(updateQuery)

    const updatedCount = result.rowCount ?? 0
    processedRows += updatedCount

    const elapsed = (Date.now() - startTime) / 1000
    const rate = processedRows / elapsed
    const remaining = totalRows - processedRows
    const eta = remaining / rate

    log(
      `  Batch ${batchNumber}: Updated ${updatedCount} rows | `
        + `Progress: ${processedRows.toLocaleString()}/${totalRows.toLocaleString()} (${((processedRows / totalRows) * 100).toFixed(1)}%) | `
        + `Rate: ${rate.toFixed(0)}/s | ETA: ${formatDuration(eta)}`,
    )

    return updatedCount > 0 && processedRows < totalRows
  }

  const loop = async (): Promise<void> => {
    const hasMore = await processBatch()
    return hasMore ? loop() : undefined
  }

  await loop()

  log(
    `Phase 2 complete: Processed ${processedRows.toLocaleString()} rows in ${formatDuration((Date.now() - startTime) / 1000)}`,
  )
}

/**
 * Phase 3: Backfill remaining project_id from reviews table
 * For judgments that have review_id but no project_id
 */
const runPhase3ProjectIdFromReviews = async (db: ReturnType<typeof drizzle>) => {
  log('=== Phase 3: Backfilling project_id from reviews ===')

  const countResult = await db.execute<{count: string}>(sql`
    SELECT COUNT(*) as count FROM judgments j
    JOIN reviews r ON j.review_id = r.id
    WHERE j.project_id IS NULL
  `)
  const totalToUpdate = parseInt(countResult.rows[0]?.count ?? '0', 10)
  log(`Found ${totalToUpdate.toLocaleString()} judgments with review_id to derive project_id`)

  const totalRows = totalToUpdate
  let processedRows = 0
  let batchNumber = 0

  const startTime = Date.now()

  const processBatch = async (): Promise<boolean> => {
    batchNumber++

    const updateQuery = sql`
      WITH batch AS (
        SELECT j.id, r.project_id as derived_project_id
        FROM judgments j
        JOIN reviews r ON j.review_id = r.id
        WHERE j.project_id IS NULL
        ORDER BY j.id
        LIMIT ${BATCH_SIZE}
      )
      UPDATE judgments j
      SET project_id = b.derived_project_id
      FROM batch b
      WHERE j.id = b.id
      RETURNING j.id
    `

    const result = DRY_RUN ? {rowCount: Math.min(BATCH_SIZE, totalRows - processedRows)} : await db.execute(updateQuery)

    const updatedCount = result.rowCount ?? 0
    processedRows += updatedCount

    const elapsed = (Date.now() - startTime) / 1000
    const rate = processedRows / elapsed
    const remaining = totalRows - processedRows
    const eta = remaining / rate

    log(
      `  Batch ${batchNumber}: Updated ${updatedCount} rows | `
        + `Progress: ${processedRows.toLocaleString()}/${totalRows.toLocaleString()} (${((processedRows / totalRows) * 100).toFixed(1)}%) | `
        + `Rate: ${rate.toFixed(0)}/s | ETA: ${formatDuration(eta)}`,
    )

    return updatedCount > 0 && processedRows < totalRows
  }

  const loop = async (): Promise<void> => {
    const hasMore = await processBatch()
    return hasMore ? loop() : undefined
  }

  await loop()

  log(
    `Phase 3 complete: Processed ${processedRows.toLocaleString()} rows in ${formatDuration((Date.now() - startTime) / 1000)}`,
  )
}

/**
 * Summary: Show final stats
 */
const showSummary = async (db: ReturnType<typeof drizzle>) => {
  log('=== Final Summary ===')

  const stats = await db.execute<{
    total: string
    has_article_title: string
    has_project_id: string
    has_article_created_at: string
  }>(sql`
    SELECT
      COUNT(*) as total,
      COUNT(article_title) as has_article_title,
      COUNT(project_id) as has_project_id,
      COUNT(article_created_at) as has_article_created_at
    FROM judgments
  `)

  const row = stats.rows[0]
  const total = parseInt(row?.total ?? '0', 10)
  const hasArticleTitle = parseInt(row?.has_article_title ?? '0', 10)
  const hasProjectId = parseInt(row?.has_project_id ?? '0', 10)
  const hasArticleCreatedAt = parseInt(row?.has_article_created_at ?? '0', 10)

  log(`Total judgments: ${total.toLocaleString()}`)
  log(
    `  - article_title filled: ${hasArticleTitle.toLocaleString()} (${((hasArticleTitle / total) * 100).toFixed(1)}%)`,
  )
  log(
    `  - article_created_at filled: ${hasArticleCreatedAt.toLocaleString()} (${((hasArticleCreatedAt / total) * 100).toFixed(1)}%)`,
  )
  log(`  - project_id filled: ${hasProjectId.toLocaleString()} (${((hasProjectId / total) * 100).toFixed(1)}%)`)

  const remaining = await db.execute<{count: string}>(sql`
    SELECT COUNT(*) as count FROM judgments WHERE project_id IS NULL
  `)
  const remainingNull = parseInt(remaining.rows[0]?.count ?? '0', 10)
  log(`  - project_id still NULL: ${remainingNull.toLocaleString()}`)
}

const formatDuration = (seconds: number): string => {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`
}

const main = async () => {
  log('Starting backfill script')
  log(`Configuration: BATCH_SIZE=${BATCH_SIZE}, DRY_RUN=${DRY_RUN}, PHASE=${PHASE}`)

  const runPhases = async () => {
    const shouldRunPhase = (phase: string) => {
      return PHASE === 'all' || PHASE === phase
    }

    shouldRunPhase('1') && (await runPhase1ArticleFields(db))
    shouldRunPhase('2') && (await runPhase2ProjectIdFromSnapshot(db))
    shouldRunPhase('3') && (await runPhase3ProjectIdFromReviews(db))
  }

  await runPhases()
  await showSummary(db)

  log('Backfill complete!')
}

main().catch((err) => {
  console.error('Backfill failed:', err)
  process.exit(1)
})
