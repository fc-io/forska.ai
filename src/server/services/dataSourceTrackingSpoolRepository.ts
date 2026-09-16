import {randomUUID} from 'node:crypto'
import {mkdirSync} from 'node:fs'
import {dirname, join, resolve} from 'node:path'

import {Database} from 'bun:sqlite'

import type {DataSourceReconciliationRunKind} from '../../db/schemaTypes.ts'
import {getEnv} from '../utils/env.ts'
import {getJsonValue} from './appQueryHelpers.ts'

export type DataSourceTrackingSpoolRunKind = 'incremental' | DataSourceReconciliationRunKind
export type DataSourceTrackingSpoolWindowStatus =
  | 'fetching'
  | 'ready'
  | 'ingesting'
  | 'ingested'
  | 'fetch_failed'
  | 'ingest_failed'
  | 'rejected'

export type DataSourceTrackingSpoolWindowRecord = {
  id: string
  dataSourceId: string
  route: string
  runKind: DataSourceTrackingSpoolRunKind
  windowStart: Date
  windowEnd: Date
  status: DataSourceTrackingSpoolWindowStatus
  cursor: string | null
  failureCount: number
  lastError: string | null
  leaseOwner: string | null
  leaseExpiresAt: Date | null
  nextRetryAt: Date | null
  spooledAt: Date | null
  duckdbIngestedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export type DataSourceTrackingSpoolPageRecord = {
  id: string
  windowId: string
  pageIndex: number
  cursorBefore: string | null
  cursorAfter: string | null
  sourceRecordCount: number
  sourceRecordHash: string
  rawPayloadJson: unknown
  normalizedRecordsJson: unknown
  fetchedAt: Date
  duckdbIngestedAt: Date | null
}

export type DataSourceTrackingSpoolBacklog = {
  failedWindowCount: number
  oldestReadyAt: Date | null
  pendingPageCount: number
  pendingWindowCount: number
  readyWindowCount: number
}

type CreateDataSourceTrackingSpoolRepositoryOptions = {database?: Database; sqlitePath?: string}

type SpoolWindowRow = {
  created_at: string
  cursor: string | null
  data_source_id: string
  duckdb_ingested_at: string | null
  failure_count: number
  id: string
  last_error: string | null
  lease_expires_at: string | null
  lease_owner: string | null
  next_retry_at: string | null
  route: string
  run_kind: string
  spooled_at: string | null
  status: string
  updated_at: string
  window_end: string
  window_start: string
}

type SpoolPageRow = {
  cursor_after: string | null
  cursor_before: string | null
  duckdb_ingested_at: string | null
  fetched_at: string
  id: string
  normalized_records_json: string
  page_index: number
  raw_payload_json: string
  source_record_count: number
  source_record_hash: string
  window_id: string
}

const getDateOrNull = (value: string | null | undefined) => {
  if (!value) {
    return null
  }

  const date = new Date(value)

  return Number.isNaN(date.getTime()) ? null : date
}

const getDateValue = (value: string, fieldName: string) => {
  const date = getDateOrNull(value)

  if (!date) {
    throw new Error(`Invalid tracking spool ${fieldName}`)
  }

  return date
}

const getSpoolRunKind = (value: string): DataSourceTrackingSpoolRunKind => {
  if (value === 'incremental' || value === 'automatic_age_bucket' || value === 'manual_full_range') {
    return value
  }

  throw new Error(`Invalid tracking spool run kind: ${value}`)
}

const getSpoolWindowStatus = (value: string): DataSourceTrackingSpoolWindowStatus => {
  if (
    value === 'fetching'
    || value === 'ready'
    || value === 'ingesting'
    || value === 'ingested'
    || value === 'fetch_failed'
    || value === 'ingest_failed'
    || value === 'rejected'
  ) {
    return value
  }

  throw new Error(`Invalid tracking spool window status: ${value}`)
}

const getWindowRecordFromRow = (row: SpoolWindowRow): DataSourceTrackingSpoolWindowRecord => {
  return {
    createdAt: getDateValue(row.created_at, 'created_at'),
    cursor: row.cursor,
    dataSourceId: row.data_source_id,
    duckdbIngestedAt: getDateOrNull(row.duckdb_ingested_at),
    failureCount: Number(row.failure_count ?? 0),
    id: row.id,
    lastError: row.last_error,
    leaseExpiresAt: getDateOrNull(row.lease_expires_at),
    leaseOwner: row.lease_owner,
    nextRetryAt: getDateOrNull(row.next_retry_at),
    route: row.route,
    runKind: getSpoolRunKind(row.run_kind),
    spooledAt: getDateOrNull(row.spooled_at),
    status: getSpoolWindowStatus(row.status),
    updatedAt: getDateValue(row.updated_at, 'updated_at'),
    windowEnd: getDateValue(row.window_end, 'window_end'),
    windowStart: getDateValue(row.window_start, 'window_start'),
  }
}

const getPageRecordFromRow = (row: SpoolPageRow): DataSourceTrackingSpoolPageRecord => {
  return {
    cursorAfter: row.cursor_after,
    cursorBefore: row.cursor_before,
    duckdbIngestedAt: getDateOrNull(row.duckdb_ingested_at),
    fetchedAt: getDateValue(row.fetched_at, 'fetched_at'),
    id: row.id,
    normalizedRecordsJson: getJsonValue(row.normalized_records_json),
    pageIndex: Number(row.page_index),
    rawPayloadJson: getJsonValue(row.raw_payload_json),
    sourceRecordCount: Number(row.source_record_count),
    sourceRecordHash: row.source_record_hash,
    windowId: row.window_id,
  }
}

export const getDefaultDataSourceTrackingSpoolPath = () => {
  const duckdbPath = getEnv().DUCKDB_PATH
  const runtimeRoot = duckdbPath === ':memory:' ? resolve(process.cwd(), 'data/runtime/local') : dirname(duckdbPath)

  return join(runtimeRoot, 'data-source-tracking-spool.sqlite')
}

const initializeSpoolDatabase = (database: Database) => {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS tracking_spool_window (
      id TEXT PRIMARY KEY,
      data_source_id TEXT NOT NULL,
      route TEXT NOT NULL,
      run_kind TEXT NOT NULL,
      window_start TEXT NOT NULL,
      window_end TEXT NOT NULL,
      status TEXT NOT NULL,
      cursor TEXT,
      failure_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      lease_owner TEXT,
      lease_expires_at TEXT,
      next_retry_at TEXT,
      spooled_at TEXT,
      duckdb_ingested_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(data_source_id, route, run_kind, window_start, window_end)
    );

    CREATE TABLE IF NOT EXISTS tracking_spool_page (
      id TEXT PRIMARY KEY,
      window_id TEXT NOT NULL REFERENCES tracking_spool_window(id),
      page_index INTEGER NOT NULL,
      cursor_before TEXT,
      cursor_after TEXT,
      source_record_count INTEGER NOT NULL,
      source_record_hash TEXT NOT NULL,
      raw_payload_json TEXT NOT NULL,
      normalized_records_json TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      duckdb_ingested_at TEXT,
      UNIQUE(window_id, page_index)
    );

    CREATE TABLE IF NOT EXISTS tracking_spool_source_record_key (
      window_id TEXT NOT NULL REFERENCES tracking_spool_window(id) ON DELETE CASCADE,
      source_record_key TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      PRIMARY KEY(window_id, source_record_key)
    );

    CREATE INDEX IF NOT EXISTS idx_tracking_spool_window_ready
      ON tracking_spool_window(status, spooled_at, lease_expires_at);
    CREATE INDEX IF NOT EXISTS idx_tracking_spool_page_window
      ON tracking_spool_page(window_id, page_index);
    CREATE INDEX IF NOT EXISTS idx_tracking_spool_source_record_key_window
      ON tracking_spool_source_record_key(window_id, source_record_key);
  `)
}

const openSpoolDatabase = (sqlitePath: string) => {
  mkdirSync(dirname(sqlitePath), {recursive: true})
  const database = new Database(sqlitePath, {create: true})

  initializeSpoolDatabase(database)

  return database
}

const getLimitValue = (limit: number) => {
  return Math.max(0, Math.trunc(limit))
}

const getWindowById = (database: Database, id: string): DataSourceTrackingSpoolWindowRecord | null => {
  const row = database
    .query(`SELECT * FROM tracking_spool_window WHERE id = ? LIMIT 1`)
    .get(id) as SpoolWindowRow | null

  return row ? getWindowRecordFromRow(row) : null
}

const getClaimableWindowRows = (database: Database, input: {limit: number; now: Date}) => {
  return database
    .query(
      `
      SELECT *
      FROM tracking_spool_window
      WHERE status = 'ready'
        OR (
          status = 'ingest_failed'
          AND spooled_at IS NOT NULL
          AND (next_retry_at IS NULL OR next_retry_at <= ?)
        )
        OR (
          status = 'ingesting'
          AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
        )
      ORDER BY spooled_at IS NULL ASC, spooled_at ASC, created_at ASC, id ASC
      LIMIT ?
    `,
    )
    .all(input.now.toISOString(), input.now.toISOString(), getLimitValue(input.limit)) as SpoolWindowRow[]
}

export const createDataSourceTrackingSpoolRepository = (
  options: CreateDataSourceTrackingSpoolRepositoryOptions = {},
) => {
  const database = options.database ?? openSpoolDatabase(options.sqlitePath ?? getDefaultDataSourceTrackingSpoolPath())
  const ownsDatabase = !options.database
  const getBacklog = (input: {excludeWindowId?: string} = {}): DataSourceTrackingSpoolBacklog => {
    const [windowCounts] = database
      .query(
        `
        SELECT
          SUM(CASE WHEN status IN ('fetching', 'fetch_failed', 'ready', 'ingesting', 'ingest_failed') THEN 1 ELSE 0 END) AS pendingWindowCount,
          SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS readyWindowCount,
          SUM(CASE WHEN status IN ('fetch_failed', 'ingest_failed', 'rejected') THEN 1 ELSE 0 END) AS failedWindowCount,
          MIN(CASE WHEN status = 'ready' THEN spooled_at ELSE NULL END) AS oldestReadyAt
        FROM tracking_spool_window
        WHERE (? IS NULL OR id <> ?)
      `,
      )
      .all(input.excludeWindowId ?? null, input.excludeWindowId ?? null) as Array<{
      failedWindowCount: number | null
      oldestReadyAt: string | null
      pendingWindowCount: number | null
      readyWindowCount: number | null
    }>
    const [pageCount] = database
      .query(
        `
        SELECT COUNT(*) AS pendingPageCount
        FROM tracking_spool_page page
        INNER JOIN tracking_spool_window spool_window ON spool_window.id = page.window_id
        WHERE page.duckdb_ingested_at IS NULL
          AND (? IS NULL OR page.window_id <> ?)
          AND spool_window.status IN ('fetching', 'fetch_failed', 'ready', 'ingesting', 'ingest_failed')
      `,
      )
      .all(input.excludeWindowId ?? null, input.excludeWindowId ?? null) as Array<{pendingPageCount: number | null}>

    return {
      failedWindowCount: Number(windowCounts?.failedWindowCount ?? 0),
      oldestReadyAt: getDateOrNull(windowCounts?.oldestReadyAt),
      pendingPageCount: Number(pageCount?.pendingPageCount ?? 0),
      pendingWindowCount: Number(windowCounts?.pendingWindowCount ?? 0),
      readyWindowCount: Number(windowCounts?.readyWindowCount ?? 0),
    }
  }

  return {
    appendPage: (input: {
      cursorAfter: string | null
      cursorBefore: string | null
      fetchedAt?: Date
      id?: string
      normalizedRecordsJson: unknown
      pageIndex: number
      rawPayloadJson: unknown
      sourceRecordCount: number
      sourceRecordHash: string
      windowId: string
    }): DataSourceTrackingSpoolPageRecord => {
      const pageId = input.id ?? randomUUID()
      const fetchedAt = input.fetchedAt ?? new Date()
      const updatedAt = new Date().toISOString()

      return database.transaction(() => {
        const window = getWindowById(database, input.windowId)

        if (!window) {
          throw new Error('Tracking spool window not found')
        }

        if (window.status === 'ingested') {
          throw new Error('Cannot append a page to an ingested tracking spool window')
        }

        database
          .query(
            `
            INSERT INTO tracking_spool_page (
              id,
              window_id,
              page_index,
              cursor_before,
              cursor_after,
              source_record_count,
              source_record_hash,
              raw_payload_json,
              normalized_records_json,
              fetched_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          )
          .run(
            pageId,
            input.windowId,
            input.pageIndex,
            input.cursorBefore,
            input.cursorAfter,
            input.sourceRecordCount,
            input.sourceRecordHash,
            JSON.stringify(input.rawPayloadJson),
            JSON.stringify(input.normalizedRecordsJson),
            fetchedAt.toISOString(),
          )

        database
          .query(
            `
            UPDATE tracking_spool_window
            SET cursor = ?,
                status = CASE WHEN status = 'fetch_failed' THEN 'fetching' ELSE status END,
                updated_at = ?
            WHERE id = ?
          `,
          )
          .run(input.cursorAfter, updatedAt, input.windowId)

        const page = database
          .query(`SELECT * FROM tracking_spool_page WHERE id = ? LIMIT 1`)
          .get(pageId) as SpoolPageRow | null

        if (!page) {
          throw new Error('Failed to append tracking spool page')
        }

        return getPageRecordFromRow(page)
      })()
    },
    claimReadyWindowsForIngest: (input: {
      leaseExpiresAt: Date
      leaseOwner: string
      limit: number
      now?: Date
    }): DataSourceTrackingSpoolWindowRecord[] => {
      const now = input.now ?? new Date()

      return database.transaction(() => {
        const rows = getClaimableWindowRows(database, {limit: input.limit, now})
        const claimed: DataSourceTrackingSpoolWindowRecord[] = []

        for (const row of rows) {
          const result = database
            .query(
              `
              UPDATE tracking_spool_window
              SET status = 'ingesting',
                  lease_owner = ?,
                  lease_expires_at = ?,
                  updated_at = ?
                WHERE id = ?
                  AND (
                    status = 'ready'
                    OR (
                      status = 'ingest_failed'
                      AND spooled_at IS NOT NULL
                      AND (next_retry_at IS NULL OR next_retry_at <= ?)
                    )
                    OR (
                      status = 'ingesting'
                      AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
                    )
                )
            `,
            )
            .run(
              input.leaseOwner,
              input.leaseExpiresAt.toISOString(),
              now.toISOString(),
              row.id,
              now.toISOString(),
              now.toISOString(),
            ) as {changes?: number}

          if ((result.changes ?? 0) > 0) {
            const claimedWindow = getWindowById(database, row.id)

            if (claimedWindow) {
              claimed.push(claimedWindow)
            }
          }
        }

        return claimed
      })()
    },
    cleanupIngested: (input: {ingestedBefore: Date; limit: number}): {pagesDeleted: number; windowsDeleted: number} => {
      return database.transaction(() => {
        const rows = database
          .query(
            `
            SELECT id
            FROM tracking_spool_window
            WHERE status = 'ingested'
              AND duckdb_ingested_at IS NOT NULL
              AND duckdb_ingested_at <= ?
            ORDER BY duckdb_ingested_at ASC, id ASC
            LIMIT ?
          `,
          )
          .all(input.ingestedBefore.toISOString(), getLimitValue(input.limit)) as Array<{id: string}>
        const ids = rows.map((row) => {
          return row.id
        })

        if (ids.length === 0) {
          return {pagesDeleted: 0, windowsDeleted: 0}
        }

        const placeholders = ids
          .map(() => {
            return '?'
          })
          .join(', ')
        const keysResult = database
          .query(`DELETE FROM tracking_spool_source_record_key WHERE window_id IN (${placeholders})`)
          .run(...ids) as {changes?: number}
        const pagesResult = database
          .query(`DELETE FROM tracking_spool_page WHERE window_id IN (${placeholders})`)
          .run(...ids) as {changes?: number}
        const windowsResult = database
          .query(`DELETE FROM tracking_spool_window WHERE id IN (${placeholders})`)
          .run(...ids) as {changes?: number}

        void keysResult

        return {pagesDeleted: pagesResult.changes ?? 0, windowsDeleted: windowsResult.changes ?? 0}
      })()
    },
    close: () => {
      if (ownsDatabase) {
        database.close(false)
      }
    },
    createOrResumeWindow: (input: {
      dataSourceId: string
      id?: string
      now?: Date
      route: string
      runKind: DataSourceTrackingSpoolRunKind
      windowEnd: Date
      windowStart: Date
    }): DataSourceTrackingSpoolWindowRecord => {
      return database.transaction(() => {
        const now = input.now ?? new Date()
        const id = input.id ?? randomUUID()
        const identityArgs = [
          input.dataSourceId,
          input.route,
          input.runKind,
          input.windowStart.toISOString(),
          input.windowEnd.toISOString(),
        ] as const
        const existing = database
          .query(
            `
            SELECT *
            FROM tracking_spool_window
            WHERE data_source_id = ?
              AND route = ?
              AND run_kind = ?
              AND window_start = ?
              AND window_end = ?
            LIMIT 1
          `,
          )
          .get(...identityArgs) as SpoolWindowRow | null

        if (
          existing
          && ((input.id
            && existing.id !== input.id
            && input.runKind === 'manual_full_range'
            && (existing.status === 'ingested' || existing.status === 'rejected'))
            || (existing.status === 'rejected' && (input.runKind === 'incremental' || input.id)))
        ) {
          database.query(`DELETE FROM tracking_spool_source_record_key WHERE window_id = ?`).run(existing.id)
          database.query(`DELETE FROM tracking_spool_page WHERE window_id = ?`).run(existing.id)
          database.query(`DELETE FROM tracking_spool_window WHERE id = ?`).run(existing.id)
        }

        database
          .query(
            `
            INSERT INTO tracking_spool_window (
              id,
              data_source_id,
              route,
              run_kind,
              window_start,
              window_end,
              status,
              created_at,
              updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, 'fetching', ?, ?)
            ON CONFLICT(data_source_id, route, run_kind, window_start, window_end) DO NOTHING
          `,
          )
          .run(
            id,
            input.dataSourceId,
            input.route,
            input.runKind,
            input.windowStart.toISOString(),
            input.windowEnd.toISOString(),
            now.toISOString(),
            now.toISOString(),
          )

        const row = database
          .query(
            `
            SELECT *
            FROM tracking_spool_window
            WHERE data_source_id = ?
              AND route = ?
              AND run_kind = ?
              AND window_start = ?
              AND window_end = ?
            LIMIT 1
          `,
          )
          .get(...identityArgs) as SpoolWindowRow | null

        if (!row) {
          throw new Error('Failed to create or resume tracking spool window')
        }

        return getWindowRecordFromRow(row)
      })()
    },
    getBacklog,
    getBackpressureSignal: (input: {
      excludeWindowId?: string
      maxPendingPages: number
      maxPendingWindows: number
    }): {backlog: DataSourceTrackingSpoolBacklog; backpressureActive: boolean} => {
      const backlog = getBacklog({excludeWindowId: input.excludeWindowId})

      return {
        backlog,
        backpressureActive:
          backlog.pendingPageCount >= input.maxPendingPages || backlog.pendingWindowCount >= input.maxPendingWindows,
      }
    },
    hasRetryableFetchFailedWindow: (input: {dataSourceId?: string; now: Date; windowId?: string | null}): boolean => {
      const row = database
        .query(
          `
          SELECT 1
          FROM tracking_spool_window spool_window
          WHERE spool_window.status = 'fetch_failed'
            AND (? IS NULL OR spool_window.id = ?)
            AND (? IS NULL OR spool_window.data_source_id = ?)
            AND (spool_window.next_retry_at IS NULL OR spool_window.next_retry_at <= ?)
            AND EXISTS (
              SELECT 1
              FROM tracking_spool_page page
              WHERE page.window_id = spool_window.id
              LIMIT 1
            )
          LIMIT 1
        `,
        )
        .get(
          input.windowId ?? null,
          input.windowId ?? null,
          input.dataSourceId ?? null,
          input.dataSourceId ?? null,
          input.now.toISOString(),
        )

      return Boolean(row)
    },
    getResumeCursor: (windowId: string): string | null => {
      const window = getWindowById(database, windowId)

      return window?.cursor ?? null
    },
    getWindow: (windowId: string): DataSourceTrackingSpoolWindowRecord | null => {
      return getWindowById(database, windowId)
    },
    getWindowPages: (windowId: string): DataSourceTrackingSpoolPageRecord[] => {
      const rows = database
        .query(
          `
          SELECT *
          FROM tracking_spool_page
          WHERE window_id = ?
          ORDER BY page_index ASC
        `,
        )
        .all(windowId) as SpoolPageRow[]

      return rows.map(getPageRecordFromRow)
    },
    getWindowPagesBatch: (input: {
      afterPageIndex?: number
      limit: number
      windowId: string
    }): DataSourceTrackingSpoolPageRecord[] => {
      const rows = database
        .query(
          `
          SELECT *
          FROM tracking_spool_page
          WHERE window_id = ?
            AND page_index > ?
          ORDER BY page_index ASC
          LIMIT ?
        `,
        )
        .all(input.windowId, input.afterPageIndex ?? -1, getLimitValue(input.limit)) as SpoolPageRow[]

      return rows.map(getPageRecordFromRow)
    },
    getWindowSourceRecordKeysBatch: (input: {
      afterSourceRecordKey?: string | null
      limit: number
      windowId: string
    }): string[] => {
      const rows = database
        .query(
          `
          SELECT source_record_key AS sourceRecordKey
          FROM tracking_spool_source_record_key
          WHERE window_id = ?
            AND source_record_key > ?
          ORDER BY source_record_key ASC
          LIMIT ?
        `,
        )
        .all(input.windowId, input.afterSourceRecordKey ?? '', getLimitValue(input.limit)) as Array<{
        sourceRecordKey: string
      }>

      return rows.map((row) => {
        return row.sourceRecordKey
      })
    },
    markWindowFailed: (input: {
      error: string
      nextRetryAt?: Date | null
      now?: Date
      status?: 'fetch_failed' | 'ingest_failed'
      windowId: string
    }): DataSourceTrackingSpoolWindowRecord | null => {
      const now = input.now ?? new Date()
      const status = input.status ?? 'ingest_failed'

      database
        .query(
          `
          UPDATE tracking_spool_window
          SET status = ?,
              failure_count = failure_count + 1,
              last_error = ?,
              lease_owner = NULL,
              lease_expires_at = NULL,
              next_retry_at = ?,
              updated_at = ?
          WHERE id = ?
        `,
        )
        .run(status, input.error, input.nextRetryAt?.toISOString() ?? null, now.toISOString(), input.windowId)

      return getWindowById(database, input.windowId)
    },
    markWindowRejected: (input: {
      error: string
      now?: Date
      windowId: string
    }): DataSourceTrackingSpoolWindowRecord | null => {
      const now = input.now ?? new Date()

      database
        .query(
          `
          UPDATE tracking_spool_window
          SET status = 'rejected',
              failure_count = failure_count + 1,
              last_error = ?,
              lease_owner = NULL,
              lease_expires_at = NULL,
              next_retry_at = NULL,
              updated_at = ?
          WHERE id = ?
        `,
        )
        .run(input.error, now.toISOString(), input.windowId)

      return getWindowById(database, input.windowId)
    },
    markWindowIngested: (input: {
      ingestedAt?: Date
      leaseOwner?: string | null
      windowId: string
    }): DataSourceTrackingSpoolWindowRecord | null => {
      const ingestedAt = input.ingestedAt ?? new Date()

      return database.transaction(() => {
        const result = input.leaseOwner
          ? (database
              .query(
                `
            UPDATE tracking_spool_window
            SET status = 'ingested',
                duckdb_ingested_at = ?,
                lease_owner = NULL,
                lease_expires_at = NULL,
                updated_at = ?
            WHERE id = ?
              AND lease_owner = ?
          `,
              )
              .run(ingestedAt.toISOString(), ingestedAt.toISOString(), input.windowId, input.leaseOwner) as {
              changes?: number
            })
          : (database
              .query(
                `
            UPDATE tracking_spool_window
            SET status = 'ingested',
                duckdb_ingested_at = ?,
                lease_owner = NULL,
                lease_expires_at = NULL,
                updated_at = ?
            WHERE id = ?
          `,
              )
              .run(ingestedAt.toISOString(), ingestedAt.toISOString(), input.windowId) as {changes?: number})

        if ((result.changes ?? 0) === 0) {
          return getWindowById(database, input.windowId)
        }

        database
          .query(
            `
            UPDATE tracking_spool_page
            SET duckdb_ingested_at = ?
            WHERE window_id = ?
          `,
          )
          .run(ingestedAt.toISOString(), input.windowId)

        return getWindowById(database, input.windowId)
      })()
    },
    markWindowReady: (input: {spooledAt?: Date; windowId: string}): DataSourceTrackingSpoolWindowRecord | null => {
      const spooledAt = input.spooledAt ?? new Date()

      database
        .query(
          `
          UPDATE tracking_spool_window
          SET status = 'ready',
              spooled_at = ?,
              lease_owner = NULL,
              lease_expires_at = NULL,
              last_error = NULL,
              next_retry_at = NULL,
              updated_at = ?
          WHERE id = ?
            AND status IN ('fetching', 'fetch_failed', 'ready')
        `,
        )
        .run(spooledAt.toISOString(), spooledAt.toISOString(), input.windowId)

      return getWindowById(database, input.windowId)
    },
    recordWindowSourceRecordKeys: (input: {
      now?: Date
      sourceRecordKeys: string[]
      windowId: string
    }): {insertedCount: number} => {
      const keys = [...new Set(input.sourceRecordKeys)].filter((key) => {
        return key.trim() !== ''
      })

      if (keys.length === 0) {
        return {insertedCount: 0}
      }

      const now = input.now ?? new Date()

      return database.transaction(() => {
        let insertedCount = 0
        const insert = database.query(
          `
          INSERT OR IGNORE INTO tracking_spool_source_record_key (
            window_id,
            source_record_key,
            first_seen_at
          )
          VALUES (?, ?, ?)
        `,
        )

        for (const key of keys) {
          const result = insert.run(input.windowId, key, now.toISOString()) as {changes?: number}

          insertedCount += result.changes ?? 0
        }

        return {insertedCount}
      })()
    },
    renewWindowLease: (input: {
      leaseExpiresAt: Date
      leaseOwner: string
      now?: Date
      windowId: string
    }): DataSourceTrackingSpoolWindowRecord | null => {
      const now = input.now ?? new Date()
      const result = database
        .query(
          `
          UPDATE tracking_spool_window
          SET lease_expires_at = ?,
              updated_at = ?
          WHERE id = ?
            AND status = 'ingesting'
            AND lease_owner = ?
        `,
        )
        .run(input.leaseExpiresAt.toISOString(), now.toISOString(), input.windowId, input.leaseOwner) as {
        changes?: number
      }

      return (result.changes ?? 0) > 0 ? getWindowById(database, input.windowId) : null
    },
  }
}

let cachedDataSourceTrackingSpoolRepository: ReturnType<typeof createDataSourceTrackingSpoolRepository> | null = null

export const getDataSourceTrackingSpoolRepository = () => {
  cachedDataSourceTrackingSpoolRepository ??= createDataSourceTrackingSpoolRepository()

  return cachedDataSourceTrackingSpoolRepository
}
