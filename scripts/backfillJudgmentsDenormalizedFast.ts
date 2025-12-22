/**
 * FAST Backfill script for denormalized judgment fields
 *
 * Optimized version using:
 * - Parallel workers
 * - Pre-fetched ID batches (avoids ORDER BY on UUID)
 * - Direct UUID array updates (no subqueries)
 *
 * Usage: bun scripts/backfillJudgmentsDenormalizedFast.ts
 *
 * Options (via env vars):
 *   BATCH_SIZE=10000   - Number of rows per batch (default: 10000)
 *   WORKERS=4          - Number of parallel workers (default: 4)
 *   DRY_RUN=true       - Preview without making changes
 *   PHASE=1|2|3|all    - Run specific phase or all (default: all)
 */

import {sql} from 'drizzle-orm'
import {drizzle} from 'drizzle-orm/node-postgres'
import pg from 'pg'

import {env} from '../src/server/utils/env.ts'

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE ?? '1500', 10) // Max ~1664 due to PG array limit
const WORKERS = parseInt(process.env.WORKERS ?? '4', 10)
const DRY_RUN = process.env.DRY_RUN === 'true'
const PHASE = process.env.PHASE ?? 'all'

const log = (message: string) => {
  return console.log(`[${new Date().toISOString()}] ${message}`)
}

// Create a pool for parallel connections
const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: WORKERS + 1, // Workers + 1 for coordination
})

const db = drizzle(pool, {logger: false})

const formatDuration = (seconds: number): string => {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`
}

/**
 * Format array of UUIDs as a PostgreSQL array literal
 * Drizzle doesn't handle array interpolation correctly, so we need to format manually
 */
const uuidArray = (ids: string[]) => {
  return sql.raw(`ARRAY['${ids.join("','")}'::uuid]`)
}

/**
 * Fetch all IDs needing update in chunks
 * This is much faster than ORDER BY in each batch
 */
const fetchIdsToUpdate = async (whereCondition: ReturnType<typeof sql>, description: string): Promise<string[][]> => {
  log(`Fetching IDs for: ${description}`)
  const startTime = Date.now()

  // Use a cursor-based approach to fetch all IDs efficiently
  const result = await db.execute<{id: string}>(sql`
    SELECT id::text FROM judgments WHERE ${whereCondition}
  `)

  const allIds = result.rows.map((r) => {
    return r.id
  })
  log(`Fetched ${allIds.length.toLocaleString()} IDs in ${formatDuration((Date.now() - startTime) / 1000)}`)

  // Split into batches
  const batches: string[][] = []
  for (let i = 0; i < allIds.length; i += BATCH_SIZE) {
    batches.push(allIds.slice(i, i + BATCH_SIZE))
  }

  log(`Split into ${batches.length} batches of ~${BATCH_SIZE} each`)
  return batches
}

/**
 * Process batches in parallel using worker pool
 */
const processInParallel = async (
  batches: string[][],
  updateFn: (ids: string[], workerNum: number) => Promise<number>,
  description: string,
): Promise<void> => {
  const totalRows = batches.reduce((sum, b) => {
    return sum + b.length
  }, 0)
  let processedRows = 0
  let batchesCompleted = 0
  const startTime = Date.now()

  log(`Starting ${WORKERS} parallel workers for ${description}`)

  // Create a queue of batches
  let batchIndex = 0

  const worker = async (workerNum: number): Promise<void> => {
    while (true) {
      const currentBatchIndex = batchIndex++
      if (currentBatchIndex >= batches.length) break

      const batch = batches[currentBatchIndex]
      if (!batch) break

      const updated = await updateFn(batch, workerNum)
      processedRows += updated
      batchesCompleted++

      // Log progress every 10 batches or so
      if (batchesCompleted % 10 === 0 || batchesCompleted === batches.length) {
        const elapsed = (Date.now() - startTime) / 1000
        const rate = processedRows / elapsed
        const remaining = totalRows - processedRows
        const eta = remaining / rate

        log(
          `  Progress: ${processedRows.toLocaleString()}/${totalRows.toLocaleString()} `
            + `(${((processedRows / totalRows) * 100).toFixed(1)}%) | `
            + `Batches: ${batchesCompleted}/${batches.length} | `
            + `Rate: ${rate.toFixed(0)}/s | ETA: ${formatDuration(eta)}`,
        )
      }
    }
  }

  // Start workers
  const workers = Array.from({length: WORKERS}, (_, i) => {
    return worker(i + 1)
  })
  await Promise.all(workers)

  const totalTime = (Date.now() - startTime) / 1000
  log(
    `${description} complete: ${processedRows.toLocaleString()} rows in ${formatDuration(totalTime)} (avg ${(processedRows / totalTime).toFixed(0)}/s)`,
  )
}

/**
 * Phase 1: Backfill article fields from the articles table
 */
const runPhase1ArticleFields = async () => {
  log('=== Phase 1: Backfilling article fields ===')

  const batches = await fetchIdsToUpdate(sql`article_title IS NULL`, 'judgments needing article field backfill')

  if (batches.length === 0) {
    log('No rows to update for Phase 1')
    return
  }

  const updateBatch = async (ids: string[], _workerNum: number): Promise<number> => {
    if (DRY_RUN) return ids.length

    // NOTE: articles.import_route is NULL for ~93% of articles (PubMed imports bug).
    // We resolve the import route via article_route_link → import_route junction instead.
    // Articles can have multiple route links; we pick one deterministically with LIMIT 1.
    const result = await db.execute(sql`
      UPDATE judgments j
      SET
        article_title = a.article_title,
        article_created_at = a.article_created_at,
        article_updated_at = a.article_updated_at,
        article_created_year = EXTRACT(YEAR FROM a.article_created_at)::integer,
        article_updated_year = EXTRACT(YEAR FROM a.article_updated_at)::integer,
        article_import_route = (
          SELECT ir.route
          FROM article_route_link arl
          JOIN import_route ir ON ir.id = arl.import_route_id
          WHERE arl.article_id = a.id
          ORDER BY arl.created_at ASC
          LIMIT 1
        ),
        article_imported_by = a.imported_by
      FROM articles a
      WHERE j.id = ANY(${uuidArray(ids)})
        AND j.article_id = a.id
    `)

    return result.rowCount ?? 0
  }

  await processInParallel(batches, updateBatch, 'Phase 1 (article fields)')
}

/**
 * Phase 2: Backfill project_id from snapshot_project_id
 */
const runPhase2ProjectIdFromSnapshot = async () => {
  log('=== Phase 2: Backfilling project_id from snapshot_project_id ===')

  const batches = await fetchIdsToUpdate(
    sql`project_id IS NULL AND snapshot_project_id IS NOT NULL`,
    'judgments with snapshot_project_id to copy',
  )

  if (batches.length === 0) {
    log('No rows to update for Phase 2')
    return
  }

  const updateBatch = async (ids: string[], _workerNum: number): Promise<number> => {
    if (DRY_RUN) return ids.length

    const result = await db.execute(sql`
      UPDATE judgments
      SET project_id = snapshot_project_id
      WHERE id = ANY(${uuidArray(ids)})
    `)

    return result.rowCount ?? 0
  }

  await processInParallel(batches, updateBatch, 'Phase 2 (project_id from snapshot)')
}

/**
 * Phase 3: Backfill remaining project_id from reviews table
 */
const runPhase3ProjectIdFromReviews = async () => {
  log('=== Phase 3: Backfilling project_id from reviews ===')

  // For Phase 3, we need to fetch IDs with the join condition
  log('Fetching IDs for: judgments with review_id to derive project_id')
  const startTime = Date.now()

  const result = await db.execute<{id: string}>(sql`
    SELECT j.id::text
    FROM judgments j
    JOIN reviews r ON j.review_id = r.id
    WHERE j.project_id IS NULL
  `)

  const allIds = result.rows.map((r) => {
    return r.id
  })
  log(`Fetched ${allIds.length.toLocaleString()} IDs in ${formatDuration((Date.now() - startTime) / 1000)}`)

  if (allIds.length === 0) {
    log('No rows to update for Phase 3')
    return
  }

  const batches: string[][] = []
  for (let i = 0; i < allIds.length; i += BATCH_SIZE) {
    batches.push(allIds.slice(i, i + BATCH_SIZE))
  }

  log(`Split into ${batches.length} batches of ~${BATCH_SIZE} each`)

  const updateBatch = async (ids: string[], _workerNum: number): Promise<number> => {
    if (DRY_RUN) return ids.length

    const result = await db.execute(sql`
      UPDATE judgments j
      SET project_id = r.project_id
      FROM reviews r
      WHERE j.id = ANY(${uuidArray(ids)})
        AND j.review_id = r.id
    `)

    return result.rowCount ?? 0
  }

  await processInParallel(batches, updateBatch, 'Phase 3 (project_id from reviews)')
}

/**
 * Phase 4: Backfill article_import_route via article_route_link junction
 *
 * This fixes judgments where article_import_route is NULL because the original
 * backfill used articles.import_route (which is NULL for 93% of articles due to
 * the PubMed workflow bug).
 */
const runPhase4ImportRoute = async () => {
  log('=== Phase 4: Backfilling article_import_route via junction table ===')

  const batches = await fetchIdsToUpdate(
    sql`article_import_route IS NULL`,
    'judgments needing article_import_route backfill',
  )

  if (batches.length === 0) {
    log('No rows to update for Phase 4')
    return
  }

  const updateBatch = async (ids: string[], _workerNum: number): Promise<number> => {
    if (DRY_RUN) return ids.length

    // Resolve import route via article_route_link → import_route junction
    // Articles can have multiple route links; pick one deterministically with LIMIT 1
    const result = await db.execute(sql`
      UPDATE judgments j
      SET article_import_route = (
        SELECT ir.route
        FROM article_route_link arl
        JOIN import_route ir ON ir.id = arl.import_route_id
        WHERE arl.article_id = j.article_id
        ORDER BY arl.created_at ASC
        LIMIT 1
      )
      WHERE j.id = ANY(${uuidArray(ids)})
    `)

    return result.rowCount ?? 0
  }

  await processInParallel(batches, updateBatch, 'Phase 4 (article_import_route via junction)')
}

/**
 * Summary: Show final stats
 */
const showSummary = async () => {
  log('=== Final Summary ===')

  const stats = await db.execute<{
    total: string
    has_article_title: string
    has_project_id: string
    has_article_created_at: string
    has_article_import_route: string
  }>(sql`
    SELECT
      COUNT(*) as total,
      COUNT(article_title) as has_article_title,
      COUNT(project_id) as has_project_id,
      COUNT(article_created_at) as has_article_created_at,
      COUNT(article_import_route) as has_article_import_route
    FROM judgments
  `)

  const row = stats.rows[0]
  const total = parseInt(row?.total ?? '0', 10)
  const hasArticleTitle = parseInt(row?.has_article_title ?? '0', 10)
  const hasProjectId = parseInt(row?.has_project_id ?? '0', 10)
  const hasArticleCreatedAt = parseInt(row?.has_article_created_at ?? '0', 10)
  const hasArticleImportRoute = parseInt(row?.has_article_import_route ?? '0', 10)

  log(`Total judgments: ${total.toLocaleString()}`)
  log(
    `  - article_title filled: ${hasArticleTitle.toLocaleString()} (${((hasArticleTitle / total) * 100).toFixed(1)}%)`,
  )
  log(
    `  - article_created_at filled: ${hasArticleCreatedAt.toLocaleString()} (${((hasArticleCreatedAt / total) * 100).toFixed(1)}%)`,
  )
  log(
    `  - article_import_route filled: ${hasArticleImportRoute.toLocaleString()} (${((hasArticleImportRoute / total) * 100).toFixed(1)}%)`,
  )
  log(`  - project_id filled: ${hasProjectId.toLocaleString()} (${((hasProjectId / total) * 100).toFixed(1)}%)`)

  const remainingRoute = await db.execute<{count: string}>(sql`
    SELECT COUNT(*) as count FROM judgments WHERE article_import_route IS NULL
  `)
  const remainingRouteNull = parseInt(remainingRoute.rows[0]?.count ?? '0', 10)
  log(`  - article_import_route still NULL: ${remainingRouteNull.toLocaleString()}`)

  const remaining = await db.execute<{count: string}>(sql`
    SELECT COUNT(*) as count FROM judgments WHERE project_id IS NULL
  `)
  const remainingNull = parseInt(remaining.rows[0]?.count ?? '0', 10)
  log(`  - project_id still NULL: ${remainingNull.toLocaleString()}`)
}

const main = async () => {
  log('Starting FAST backfill script')
  log(`Configuration: BATCH_SIZE=${BATCH_SIZE}, WORKERS=${WORKERS}, DRY_RUN=${DRY_RUN}, PHASE=${PHASE}`)

  const shouldRunPhase = (phase: string) => {
    return PHASE === 'all' || PHASE === phase
  }

  // PHASE=4 or PHASE=import_route runs only Phase 4 (import route fix)
  if (shouldRunPhase('1')) await runPhase1ArticleFields()
  if (shouldRunPhase('2')) await runPhase2ProjectIdFromSnapshot()
  if (shouldRunPhase('3')) await runPhase3ProjectIdFromReviews()
  if (shouldRunPhase('4') || PHASE === 'import_route') await runPhase4ImportRoute()

  await showSummary()

  log('Backfill complete!')
  await pool.end()
}

main().catch(async (err) => {
  console.error('Backfill failed:', err)
  await pool.end()
  process.exit(1)
})
