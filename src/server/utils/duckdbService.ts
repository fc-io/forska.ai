import {AsyncLocalStorage} from 'node:async_hooks'
import {createHash, randomUUID} from 'node:crypto'
import {
  constants as fsConstants,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import {access, copyFile, mkdir, rename, rm, writeFile} from 'node:fs/promises'
import {availableParallelism, tmpdir} from 'node:os'
import {basename, join} from 'node:path'

import {DuckDBConnection, DuckDBInstance, type DuckDBType, type DuckDBValue} from '@duckdb/node-api'
import {Effect} from 'effect'

import {parseDuckdbMemoryLimitToMiB} from './duckdbMemoryLimit.ts'
import {getEnv} from './env.ts'
import {ensureDuckdbPathDirectory} from './getDuckdbPath.ts'
import {
  exitWithRuntimeLogFlush,
  writeRuntimeFailureLogEvent,
  writeRuntimeLogEvent,
  writeRuntimeOperatorLogEvent,
} from './runtimeLogger.ts'
import {
  canCurrentServerOwnDuckdb,
  ensureCurrentDuckdbOwnerLease,
  registerDuckdbOwnerDemotionHandler,
  releaseCurrentDuckdbOwnerLease,
} from './serverRuntimeRole.ts'

type DuckdbRuntimeConfig = {
  appendLaneCount: number
  binary: string
  checkpointThreshold: string
  databasePath: string
  memoryLimit: string
  preserveInsertionOrder: boolean
  serializeConcurrentWork: boolean
  tempDirectory: string | null
  threads: string
}
export type ReadOnlyDuckdbRuntimeOptionsInput = {
  accessMode?: 'READ_ONLY'
  memoryLimit?: string
  tempDirectory?: string | null
  threads?: string
}
export type DuckdbSnapshot = {createdAt: string; snapshotPath: string}
export type DuckdbAppendRuntimeMetrics = {
  batchesCompleted: number
  batchesStarted: number
  laneCount: number
  lastDurationMs: number | null
  maxQueueDepth: number
  maxQueueDepthByLane: number[]
  queueDepth: number
  queueDepthByLane: number[]
  totalDurationMs: number
}
type DuckdbSingleQueueRuntimeMetrics = {
  lastDurationMs: number | null
  lastWaitMs: number | null
  maxQueueDepth: number
  queueDepth: number
  tasksCompleted: number
  tasksStarted: number
  totalDurationMs: number
  totalWaitMs: number
}
export type DuckdbQueueRuntimeMetrics = {
  background: DuckdbSingleQueueRuntimeMetrics
  main: DuckdbSingleQueueRuntimeMetrics
}
export type DuckdbTempSpillMetrics = {
  available: boolean
  error: string | null
  fileCount: number | null
  tempDirectory: string | null
  totalBytes: number | null
}
export type DuckdbWorkloadFallbackIntent = 'async' | 'legacy' | 'reject' | 'serveStale'
export type DuckdbWorkloadContext = {
  allowsTempSpill?: boolean
  fallbackIntent?: DuckdbWorkloadFallbackIntent
  maxResultBytes?: number
  maxResultRows?: number
  projectId?: string
  routeOrJobKey: string
  searchMode?: string
  timeoutMs?: number
  workloadClass: string
}
export type DuckdbWorkloadOperation =
  | 'appendTransaction'
  | 'appendQuery'
  | 'backgroundQuery'
  | 'backgroundStatement'
  | 'externalQuery'
  | 'mainQuery'
  | 'mainStatement'
  | 'maintenance'
  | 'readOnlyQuery'
  | 'transaction'
export type DuckdbWorkloadQueue = 'append' | 'background' | 'external' | 'main' | 'readOnly'
export type DuckdbWorkloadRuntimeMetric = {
  allowsTempSpill: boolean | null
  durationMs: number
  error: string | null
  fallbackIntent: DuckdbWorkloadFallbackIntent | null
  memoryLimit: string
  operation: DuckdbWorkloadOperation
  projectId: string | null
  queue: DuckdbWorkloadQueue
  queueDepthAtStart: number
  recordedAt: string
  resultBytes: number | null
  resultRows: number | null
  routeOrJobKey: string
  searchMode: string | null
  tempDirectory: string | null
  tempSpillDeltaBytes: number | null
  timeoutMs: number | null
  workloadClass: string
}
export type DuckdbBackgroundRuntimeDiagnostics = {
  configured: DuckdbRuntimeConfig
  effective: {
    checkpointThreshold: string | null
    memoryLimit: string | null
    preserveInsertionOrder: boolean | null
    tempDirectory: string | null
    threads: string | null
  }
  instanceOptions: Record<string, string>
  queues: DuckdbQueueRuntimeMetrics
  tempSpill: DuckdbTempSpillMetrics
  workloads: DuckdbWorkloadRuntimeMetric[]
}
type DuckdbWorkloadResultMetrics = {resultBytes: number | null; resultRows: number | null}
type DuckdbWorkloadDiagnosticContext = {
  context?: DuckdbWorkloadContext
  operation: DuckdbWorkloadOperation
  queue: DuckdbWorkloadQueue
  queueDepthAtStart: number
}
type DuckdbTransactionRunner = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}
type CloseDuckdbServiceOptions = {checkpointBeforeClose?: boolean; closeRuntime?: boolean; releaseOwnerLease?: boolean}
type DuckdbAppendBarrier = {
  active: boolean
  previous: DuckdbAppendBarrier | null
  promise: Promise<void>
  resolve: () => void
}
type DuckdbBoundValues = DuckDBValue[] | Record<string, DuckDBValue>
type DuckdbBoundTypes = DuckDBType[] | Record<string, DuckDBType | undefined>

type DuckdbServiceState = {
  appendBarrier: DuckdbAppendBarrier | null
  appendConnections: DuckDBConnection[]
  appendLastDurationMs: number | null
  appendMaxQueueDepthByLane: number[]
  appendPendingCountByLane: number[]
  appendQueues: Promise<void>[]
  appendTotalBatchesCompleted: number
  appendTotalBatchesStarted: number
  appendTotalDurationMs: number
  backgroundConnection: DuckDBConnection | null
  backgroundLastDurationMs: number | null
  backgroundLastWaitMs: number | null
  backgroundMaxQueueDepth: number
  backgroundPendingCount: number
  backgroundQueue: Promise<void>
  backgroundTasksCompleted: number
  backgroundTasksStarted: number
  backgroundTotalDurationMs: number
  backgroundTotalWaitMs: number
  controlConnection: DuckDBConnection | null
  controlTransactionDepth: number
  duckdbInstance: DuckDBInstance | null
  duckdbLastDurationMs: number | null
  duckdbLastWaitMs: number | null
  duckdbMaxQueueDepth: number
  duckdbPendingCount: number
  duckdbQueue: Promise<void>
  duckdbRuntimeConfig: DuckdbRuntimeConfig | null
  duckdbTasksCompleted: number
  duckdbTasksStarted: number
  duckdbTotalDurationMs: number
  duckdbTotalWaitMs: number
  duckdbWorkloadMetrics: DuckdbWorkloadRuntimeMetric[]
  nextAppendLaneIndex: number
  shutdownHooksRegistered: boolean
  startupPromise: Promise<DuckDBConnection> | null
}

type EffectFiberFailure = {
  error?: {cause?: unknown; error?: unknown; message?: string}
  failure?: {cause?: unknown; error?: unknown; message?: string}
}

const duckdbStartupRetryableErrorFragments = [
  'Failure while replaying WAL file',
  'Calling DatabaseManager::GetDefaultDatabase with no default database set',
]
const duckdbWalReplayRecoveryErrorFragments = [
  'Failure while replaying WAL file',
  'Calling DatabaseManager::GetDefaultDatabase with no default database set',
]
const duckdbAbortedTransactionErrorFragments = ['Current transaction is aborted']
const duckdbRestartRequiredErrorFragments = [
  'database has been invalidated because of a previous fatal error',
  'must be restarted prior to being used again',
]
const duckdbWorkloadMetricsLimit = 50
const duckdbWorkloadDiagnosticStorage = new AsyncLocalStorage<DuckdbWorkloadDiagnosticContext>()
const duckdbCheckpointThresholdMaxMiB = 8192
const duckdbCheckpointThresholdMinMiB = 64
const duckdbProactiveStartupPreflightMinMemoryMiB = 6401
const duckdbStartupWalPreflightDisabledEnvValue = 'false'
const duckdbStartupPreflightLockRetryDelaysMs = [100, 250, 500, 1000]
const duckdbStartupIndexedTableRepairLockRetryDelaysMs = [100, 250, 500, 1000]
type DuckdbStartupIndexedTableRepairSpec = {
  duplicateKeySelectSql: string
  lowMemoryStartupPreflight?: boolean
  mutationProbeSql: string
  postRepairSql?: string
  postRepairSchemaRequirements?: DuckdbStartupSchemaRequirement[]
  repairPrimaryKeyColumns?: string[]
  repairStrategy?: 'copy' | 'empty-derived'
  schemaRequirements?: DuckdbStartupSchemaRequirement[]
  schemaName: string
  tableName: string
}
type DuckdbStartupSchemaRequirement = {columnNames?: string[]; schemaName: string; tableName: string}
type DuckdbStartupPreflightError = Error & {
  repairMarkerOnly?: boolean
  repairMarkerPath?: string
  repairSpecs?: DuckdbStartupIndexedTableRepairSpec[]
}
const duckdbStartupIndexedTableRepairSpecs: DuckdbStartupIndexedTableRepairSpec[] = [
  {
    duplicateKeySelectSql: `
      SELECT COUNT(*) AS duplicateCount
      FROM (
        SELECT watermark_id
        FROM app.review_serving_projector_watermark
        GROUP BY watermark_id
        HAVING COUNT(*) > 1
      )
    `,
    mutationProbeSql: `
      DROP TABLE IF EXISTS startup_probe_review_serving_projector_watermark;
      CREATE TEMP TABLE startup_probe_review_serving_projector_watermark AS
      SELECT
        watermark_id,
        updated_at
      FROM app.review_serving_projector_watermark
      ORDER BY updated_at DESC, watermark_id ASC
      LIMIT 1;
      BEGIN;
      UPDATE app.review_serving_projector_watermark
      SET updated_at = current_timestamp
      WHERE watermark_id = (
        SELECT watermark_id
        FROM startup_probe_review_serving_projector_watermark
        LIMIT 1
      );
      COMMIT;
      BEGIN;
      UPDATE app.review_serving_projector_watermark
      SET updated_at = (
        SELECT updated_at
        FROM startup_probe_review_serving_projector_watermark
        LIMIT 1
      )
      WHERE watermark_id = (
        SELECT watermark_id
        FROM startup_probe_review_serving_projector_watermark
        LIMIT 1
      );
      COMMIT;
      DROP TABLE IF EXISTS startup_probe_review_serving_projector_watermark;
    `,
    lowMemoryStartupPreflight: true,
    repairPrimaryKeyColumns: ['watermark_id'],
    schemaName: 'app',
    tableName: 'review_serving_projector_watermark',
  },
  {
    duplicateKeySelectSql: `
      SELECT COUNT(*) AS duplicateCount
      FROM (
        SELECT dirty_work_id
        FROM app.review_serving_dirty_work
        GROUP BY dirty_work_id
        HAVING COUNT(*) > 1
      )
    `,
    mutationProbeSql: `
      DROP TABLE IF EXISTS startup_probe_review_serving_dirty_work;
      CREATE TEMP TABLE startup_probe_review_serving_dirty_work AS
      SELECT
        dirty_work_id,
        status,
        updated_at
      FROM app.review_serving_dirty_work
      WHERE
        status = 'pending'
        OR status = 'failed'
        OR status = 'running'
      ORDER BY updated_at ASC, latest_source_high_water_mark ASC, dirty_work_id ASC
      LIMIT 64;
      BEGIN;
      UPDATE app.review_serving_dirty_work
      SET
        status = 'running',
        updated_at = current_timestamp
      WHERE dirty_work_id IN (
        SELECT dirty_work_id
        FROM startup_probe_review_serving_dirty_work
      );
      COMMIT;
      BEGIN;
      UPDATE app.review_serving_dirty_work
      SET
        status = (
          SELECT status
          FROM startup_probe_review_serving_dirty_work
          WHERE startup_probe_review_serving_dirty_work.dirty_work_id = app.review_serving_dirty_work.dirty_work_id
          LIMIT 1
        ),
        updated_at = (
          SELECT updated_at
          FROM startup_probe_review_serving_dirty_work
          WHERE startup_probe_review_serving_dirty_work.dirty_work_id = app.review_serving_dirty_work.dirty_work_id
          LIMIT 1
        )
      WHERE dirty_work_id IN (
        SELECT dirty_work_id
        FROM startup_probe_review_serving_dirty_work
      );
      COMMIT;
      DROP TABLE IF EXISTS startup_probe_review_serving_dirty_work;
    `,
    schemaName: 'app',
    tableName: 'review_serving_dirty_work',
  },
  {
    duplicateKeySelectSql: `
      SELECT COUNT(*) AS duplicateCount
      FROM (
        SELECT dirty_ack_id
        FROM app.review_serving_dirty_work_ack
        GROUP BY dirty_ack_id
        HAVING COUNT(*) > 1
      )
    `,
    mutationProbeSql: `
      DROP TABLE IF EXISTS startup_probe_review_serving_dirty_work_ack;
      CREATE TEMP TABLE startup_probe_review_serving_dirty_work_ack AS
      SELECT
        dirty_ack_id,
        status,
        completed_at
      FROM app.review_serving_dirty_work_ack
      ORDER BY completed_at DESC, dirty_ack_id ASC
      LIMIT 1;
      BEGIN;
      UPDATE app.review_serving_dirty_work_ack
      SET
        status = 'completed',
        completed_at = current_timestamp
      WHERE dirty_ack_id = (
        SELECT dirty_ack_id
        FROM startup_probe_review_serving_dirty_work_ack
        LIMIT 1
      );
      COMMIT;
      BEGIN;
      UPDATE app.review_serving_dirty_work_ack
      SET
        status = (
          SELECT status
          FROM startup_probe_review_serving_dirty_work_ack
          LIMIT 1
        ),
        completed_at = (
          SELECT completed_at
          FROM startup_probe_review_serving_dirty_work_ack
          LIMIT 1
        )
      WHERE dirty_ack_id = (
        SELECT dirty_ack_id
        FROM startup_probe_review_serving_dirty_work_ack
        LIMIT 1
      );
      COMMIT;
      DROP TABLE IF EXISTS startup_probe_review_serving_dirty_work_ack;
    `,
    schemaName: 'app',
    tableName: 'review_serving_dirty_work_ack',
  },
  {
    duplicateKeySelectSql: `
      SELECT COUNT(*) AS duplicateCount
      FROM (
        SELECT selected_import_snapshot_id
        FROM app.review_selected_import_snapshot
        GROUP BY selected_import_snapshot_id
        HAVING COUNT(*) > 1
      )
    `,
    mutationProbeSql: `
      DROP TABLE IF EXISTS startup_probe_review_selected_import_snapshot;
      CREATE TEMP TABLE startup_probe_review_selected_import_snapshot AS
      SELECT
        selected_import_snapshot_id,
        status,
        completed_at,
        updated_at
      FROM app.review_selected_import_snapshot
      ORDER BY updated_at DESC, selected_import_snapshot_id ASC
      LIMIT 1;
      BEGIN;
      UPDATE app.review_selected_import_snapshot
      SET
        status = status,
        updated_at = current_timestamp
      WHERE selected_import_snapshot_id = (
        SELECT selected_import_snapshot_id
        FROM startup_probe_review_selected_import_snapshot
        LIMIT 1
      );
      COMMIT;
      BEGIN;
      UPDATE app.review_selected_import_snapshot
      SET
        status = (
          SELECT status
          FROM startup_probe_review_selected_import_snapshot
          LIMIT 1
        ),
        completed_at = (
          SELECT completed_at
          FROM startup_probe_review_selected_import_snapshot
          LIMIT 1
        ),
        updated_at = (
          SELECT updated_at
          FROM startup_probe_review_selected_import_snapshot
          LIMIT 1
        )
      WHERE selected_import_snapshot_id = (
        SELECT selected_import_snapshot_id
        FROM startup_probe_review_selected_import_snapshot
        LIMIT 1
      );
      COMMIT;
      DROP TABLE IF EXISTS startup_probe_review_selected_import_snapshot;
    `,
    schemaName: 'app',
    tableName: 'review_selected_import_snapshot',
  },
  {
    duplicateKeySelectSql: `
      SELECT COUNT(*) AS duplicateCount
      FROM (
        SELECT project_id, project_scope_identity, selected_import_snapshot_id, article_id
        FROM app.review_selected_article_import_v4
        GROUP BY project_id, project_scope_identity, selected_import_snapshot_id, article_id
        HAVING COUNT(*) > 1
      )
    `,
    mutationProbeSql: `
      DROP TABLE IF EXISTS startup_probe_review_selected_article_import_v4;
      CREATE TEMP TABLE startup_probe_review_selected_article_import_v4 AS
      WITH running_selected_import_ranges AS (
        SELECT
          project_id,
          chunk_start_key,
          chunk_end_key
        FROM app.review_rebuild_chunk_manifest
        WHERE projection_component = 'selectedImport'
          AND (
            status = 'running'
            OR COALESCE(last_error, '') LIKE '%Failed to delete all rows from index%'
            OR COALESCE(last_error, '') LIKE '%DuckDB%'
          )
        ORDER BY updated_at DESC, chunk_id ASC
        LIMIT 8
      ),
      running_selected_import_rows AS (
        SELECT selected_import.*
        FROM app.review_selected_article_import_v4 selected_import
        INNER JOIN running_selected_import_ranges running_range
          ON running_range.project_id = selected_import.project_id
         AND (
              running_range.chunk_start_key IS NULL
              OR selected_import.article_id >= running_range.chunk_start_key
            )
         AND (
              running_range.chunk_end_key IS NULL
              OR selected_import.article_id <= running_range.chunk_end_key
            )
        ORDER BY
          selected_import.project_id,
          selected_import.project_scope_identity,
          selected_import.selected_import_snapshot_id,
          selected_import.article_id
        LIMIT 64
      ),
      fallback_row AS (
        SELECT selected_import.*
        FROM app.review_selected_article_import_v4 selected_import
        WHERE NOT EXISTS (SELECT 1 FROM running_selected_import_rows)
        ORDER BY
          selected_import.project_id,
          selected_import.project_scope_identity,
          selected_import.selected_import_snapshot_id,
          selected_import.article_id
        LIMIT 1
      )
      SELECT *
      FROM running_selected_import_rows
      UNION ALL
      SELECT *
      FROM fallback_row;
      BEGIN;
      UPDATE app.review_selected_article_import_v4
      SET selected_import_updated_at = current_timestamp
      WHERE EXISTS (
        SELECT 1
        FROM startup_probe_review_selected_article_import_v4 probe
        WHERE app.review_selected_article_import_v4.project_id IS NOT DISTINCT FROM probe.project_id
          AND app.review_selected_article_import_v4.project_scope_identity IS NOT DISTINCT FROM probe.project_scope_identity
          AND app.review_selected_article_import_v4.selected_import_snapshot_id IS NOT DISTINCT FROM probe.selected_import_snapshot_id
          AND app.review_selected_article_import_v4.article_id IS NOT DISTINCT FROM probe.article_id
      );
      DELETE FROM app.review_selected_article_import_v4
      WHERE EXISTS (
        SELECT 1
        FROM startup_probe_review_selected_article_import_v4 probe
        WHERE app.review_selected_article_import_v4.project_id IS NOT DISTINCT FROM probe.project_id
          AND app.review_selected_article_import_v4.project_scope_identity IS NOT DISTINCT FROM probe.project_scope_identity
          AND app.review_selected_article_import_v4.selected_import_snapshot_id IS NOT DISTINCT FROM probe.selected_import_snapshot_id
          AND app.review_selected_article_import_v4.article_id IS NOT DISTINCT FROM probe.article_id
      );
      INSERT INTO app.review_selected_article_import_v4 BY NAME
      SELECT *
      FROM startup_probe_review_selected_article_import_v4;
      COMMIT;
      DROP TABLE IF EXISTS startup_probe_review_selected_article_import_v4;
    `,
    schemaName: 'app',
    tableName: 'review_selected_article_import_v4',
  },
  {
    duplicateKeySelectSql: `
      SELECT COUNT(*) AS duplicateCount
      FROM (
        SELECT request_id
        FROM app.review_rebuild_request
        GROUP BY request_id
        HAVING COUNT(*) > 1
      )
    `,
    mutationProbeSql: `
      DROP TABLE IF EXISTS startup_probe_review_rebuild_request;
      CREATE TEMP TABLE startup_probe_review_rebuild_request AS
      SELECT request_id, updated_at
      FROM app.review_rebuild_request
      ORDER BY updated_at DESC, request_id ASC
      LIMIT 1;
      BEGIN;
      UPDATE app.review_rebuild_request
      SET updated_at = current_timestamp
      WHERE request_id IN (
        SELECT request_id
        FROM startup_probe_review_rebuild_request
      );
      COMMIT;
      BEGIN;
      UPDATE app.review_rebuild_request
      SET updated_at = (
        SELECT updated_at
        FROM startup_probe_review_rebuild_request
        LIMIT 1
      )
      WHERE request_id IN (
        SELECT request_id
        FROM startup_probe_review_rebuild_request
      );
      COMMIT;
      DROP TABLE IF EXISTS startup_probe_review_rebuild_request;
    `,
    repairPrimaryKeyColumns: ['request_id'],
    schemaName: 'app',
    tableName: 'review_rebuild_request',
  },
  {
    duplicateKeySelectSql: `
      SELECT COUNT(*) AS duplicateCount
      FROM (
        SELECT chunk_id
        FROM app.review_rebuild_chunk_manifest
        GROUP BY chunk_id
        HAVING COUNT(*) > 1
      )
    `,
    mutationProbeSql: `
      DROP TABLE IF EXISTS startup_probe_review_rebuild_chunk_manifest;
      CREATE TEMP TABLE startup_probe_review_rebuild_chunk_manifest AS
      SELECT
        chunk.chunk_id,
        chunk.status,
        chunk.lease_owner,
        chunk.lease_expires_at,
        chunk.retry_after,
        chunk.last_error
      FROM app.review_rebuild_chunk_manifest chunk
      WHERE chunk.admission_state = 'admitted'
        AND chunk.status IN ('pending', 'failed', 'running')
        AND (
          chunk.request_id IS NULL
          OR EXISTS (
            SELECT 1
            FROM app.review_rebuild_request request
            WHERE request.request_id = chunk.request_id
              AND request.status IN ('admitted', 'running')
              AND request.admission_state = 'admitted'
          )
        )
      ORDER BY
        (
          SELECT request.priority
          FROM app.review_rebuild_request request
          WHERE request.request_id = chunk.request_id
          LIMIT 1
        ) DESC NULLS LAST,
        CASE
          WHEN chunk.projection_component IN (
            'projectScope',
            'selectedImport',
            'display',
            'judgmentInputContent',
            'llmStatus',
            'humanStatus',
            'queue',
            'summary',
            'payload'
          )
          THEN 0
          ELSE 1
        END ASC,
        CASE chunk.projection_component
          WHEN 'projectScope' THEN 0
          WHEN 'selectedImport' THEN 1
          WHEN 'display' THEN 2
          WHEN 'judgmentInputContent' THEN 3
          WHEN 'llmStatus' THEN 4
          WHEN 'humanStatus' THEN 5
          WHEN 'queue' THEN 6
          WHEN 'summary' THEN 7
          WHEN 'payload' THEN 8
          WHEN 'search' THEN 9
          WHEN 'posting' THEN 10
          ELSE 11
        END ASC,
        CASE
          WHEN chunk.status = 'running'
            AND (chunk.lease_expires_at IS NULL OR chunk.lease_expires_at <= current_timestamp)
          THEN 0
          ELSE 1
        END ASC,
        chunk.updated_at ASC,
        chunk.created_at ASC,
        chunk.chunk_id ASC
      LIMIT 64;
      BEGIN;
      UPDATE app.review_rebuild_chunk_manifest
      SET
        status = 'running',
        lease_owner = 'startup-preflight',
        lease_expires_at = current_timestamp,
        retry_after = NULL,
        last_error = NULL
      WHERE chunk_id IN (
        SELECT chunk_id
        FROM startup_probe_review_rebuild_chunk_manifest
      );
      COMMIT;
      BEGIN;
      UPDATE app.review_rebuild_chunk_manifest
      SET
        status = (
          SELECT status
          FROM startup_probe_review_rebuild_chunk_manifest
          WHERE startup_probe_review_rebuild_chunk_manifest.chunk_id = app.review_rebuild_chunk_manifest.chunk_id
          LIMIT 1
        ),
        lease_owner = (
          SELECT lease_owner
          FROM startup_probe_review_rebuild_chunk_manifest
          WHERE startup_probe_review_rebuild_chunk_manifest.chunk_id = app.review_rebuild_chunk_manifest.chunk_id
          LIMIT 1
        ),
        lease_expires_at = (
          SELECT lease_expires_at
          FROM startup_probe_review_rebuild_chunk_manifest
          WHERE startup_probe_review_rebuild_chunk_manifest.chunk_id = app.review_rebuild_chunk_manifest.chunk_id
          LIMIT 1
        ),
        retry_after = (
          SELECT retry_after
          FROM startup_probe_review_rebuild_chunk_manifest
          WHERE startup_probe_review_rebuild_chunk_manifest.chunk_id = app.review_rebuild_chunk_manifest.chunk_id
          LIMIT 1
        ),
        last_error = (
          SELECT last_error
          FROM startup_probe_review_rebuild_chunk_manifest
          WHERE startup_probe_review_rebuild_chunk_manifest.chunk_id = app.review_rebuild_chunk_manifest.chunk_id
          LIMIT 1
        )
      WHERE chunk_id IN (
        SELECT chunk_id
        FROM startup_probe_review_rebuild_chunk_manifest
      );
      COMMIT;
      DROP TABLE IF EXISTS startup_probe_review_rebuild_chunk_manifest;
    `,
    lowMemoryStartupPreflight: true,
    repairPrimaryKeyColumns: ['chunk_id'],
    schemaName: 'app',
    schemaRequirements: [
      {
        columnNames: ['admission_state', 'request_id', 'retry_after'],
        schemaName: 'app',
        tableName: 'review_rebuild_chunk_manifest',
      },
      {
        columnNames: ['admission_state', 'priority', 'request_id', 'status'],
        schemaName: 'app',
        tableName: 'review_rebuild_request',
      },
    ],
    tableName: 'review_rebuild_chunk_manifest',
  },
  {
    duplicateKeySelectSql: `
      SELECT COUNT(*) AS duplicateCount
      FROM (
        SELECT project_id, article_id
        FROM mart.project_scope_article
        GROUP BY project_id, article_id
        HAVING COUNT(*) > 1
      )
    `,
    mutationProbeSql: `
      DROP TABLE IF EXISTS startup_probe_project_scope_article;
      CREATE TEMP TABLE startup_probe_project_scope_article AS
      SELECT project_id, article_id, article_updated_at
      FROM mart.project_scope_article
      ORDER BY project_id, article_id
      LIMIT 1;
      BEGIN;
      UPDATE mart.project_scope_article
      SET article_updated_at = current_timestamp
      WHERE project_id = (
          SELECT project_id
          FROM startup_probe_project_scope_article
          LIMIT 1
        )
        AND article_id = (
          SELECT article_id
          FROM startup_probe_project_scope_article
          LIMIT 1
        );
      COMMIT;
      BEGIN;
      UPDATE mart.project_scope_article
      SET article_updated_at = (
        SELECT article_updated_at
        FROM startup_probe_project_scope_article
        LIMIT 1
      )
      WHERE project_id = (
          SELECT project_id
          FROM startup_probe_project_scope_article
          LIMIT 1
        )
        AND article_id = (
          SELECT article_id
          FROM startup_probe_project_scope_article
          LIMIT 1
        );
      COMMIT;
      DROP TABLE IF EXISTS startup_probe_project_scope_article;
    `,
    schemaName: 'mart',
    tableName: 'project_scope_article',
  },
  {
    duplicateKeySelectSql: `
      SELECT COUNT(*) AS duplicateCount
      FROM (
        SELECT
          project_id,
          review_config_hash,
          snapshot_id,
          list_mode_key,
          count_kind,
          summary_definition_version,
          filter_key
        FROM mart.review_article_count_serving_v4
        GROUP BY
          project_id,
          review_config_hash,
          snapshot_id,
          list_mode_key,
          count_kind,
          summary_definition_version,
          filter_key
        HAVING COUNT(*) > 1
      )
    `,
    mutationProbeSql: `
      DROP TABLE IF EXISTS startup_probe_review_article_count_serving_v4;
      CREATE TEMP TABLE startup_probe_review_article_count_serving_v4 AS
      SELECT
        project_id,
        review_config_hash,
        snapshot_id,
        list_mode_key,
        count_kind,
        summary_definition_version,
        filter_key,
        count_updated_at
      FROM mart.review_article_count_serving_v4
      ORDER BY
        project_id,
        review_config_hash,
        snapshot_id,
        list_mode_key,
        count_kind,
        summary_definition_version,
        filter_key
      LIMIT 1;
      BEGIN;
      UPDATE mart.review_article_count_serving_v4
      SET count_updated_at = current_timestamp
      WHERE project_id = (
          SELECT project_id
          FROM startup_probe_review_article_count_serving_v4
          LIMIT 1
        )
        AND review_config_hash = (
          SELECT review_config_hash
          FROM startup_probe_review_article_count_serving_v4
          LIMIT 1
        )
        AND snapshot_id = (
          SELECT snapshot_id
          FROM startup_probe_review_article_count_serving_v4
          LIMIT 1
        )
        AND list_mode_key = (
          SELECT list_mode_key
          FROM startup_probe_review_article_count_serving_v4
          LIMIT 1
        )
        AND count_kind = (
          SELECT count_kind
          FROM startup_probe_review_article_count_serving_v4
          LIMIT 1
        )
        AND summary_definition_version = (
          SELECT summary_definition_version
          FROM startup_probe_review_article_count_serving_v4
          LIMIT 1
        )
        AND filter_key = (
          SELECT filter_key
          FROM startup_probe_review_article_count_serving_v4
          LIMIT 1
        );
      COMMIT;
      BEGIN;
      UPDATE mart.review_article_count_serving_v4
      SET count_updated_at = (
        SELECT count_updated_at
        FROM startup_probe_review_article_count_serving_v4
        LIMIT 1
      )
      WHERE project_id = (
          SELECT project_id
          FROM startup_probe_review_article_count_serving_v4
          LIMIT 1
        )
        AND review_config_hash = (
          SELECT review_config_hash
          FROM startup_probe_review_article_count_serving_v4
          LIMIT 1
        )
        AND snapshot_id = (
          SELECT snapshot_id
          FROM startup_probe_review_article_count_serving_v4
          LIMIT 1
        )
        AND list_mode_key = (
          SELECT list_mode_key
          FROM startup_probe_review_article_count_serving_v4
          LIMIT 1
        )
        AND count_kind = (
          SELECT count_kind
          FROM startup_probe_review_article_count_serving_v4
          LIMIT 1
        )
        AND summary_definition_version = (
          SELECT summary_definition_version
          FROM startup_probe_review_article_count_serving_v4
          LIMIT 1
        )
        AND filter_key = (
          SELECT filter_key
          FROM startup_probe_review_article_count_serving_v4
          LIMIT 1
        );
      COMMIT;
      DROP TABLE IF EXISTS startup_probe_review_article_count_serving_v4;
    `,
    lowMemoryStartupPreflight: true,
    repairPrimaryKeyColumns: [
      'project_id',
      'review_config_hash',
      'snapshot_id',
      'list_mode_key',
      'count_kind',
      'summary_definition_version',
      'filter_key',
    ],
    schemaName: 'mart',
    tableName: 'review_article_count_serving_v4',
  },
  {
    duplicateKeySelectSql: `
      SELECT COUNT(*) AS duplicateCount
      FROM (
        SELECT
          project_id,
          review_config_hash,
          snapshot_id,
          summary_identity,
          facet_kind,
          facet_key,
          facet_value,
          summary_definition_version
        FROM mart.review_filter_facet_serving_v4
        GROUP BY
          project_id,
          review_config_hash,
          snapshot_id,
          summary_identity,
          facet_kind,
          facet_key,
          facet_value,
          summary_definition_version
        HAVING COUNT(*) > 1
      )
    `,
    mutationProbeSql: `
      DROP TABLE IF EXISTS startup_probe_review_filter_facet_serving_v4;
      CREATE TEMP TABLE startup_probe_review_filter_facet_serving_v4 AS
      SELECT
        project_id,
        review_config_hash,
        snapshot_id,
        summary_identity,
        facet_kind,
        facet_key,
        facet_value,
        summary_definition_version,
        facet_updated_at
      FROM mart.review_filter_facet_serving_v4
      ORDER BY
        project_id,
        review_config_hash,
        snapshot_id,
        summary_identity,
        facet_kind,
        facet_key,
        facet_value,
        summary_definition_version
      LIMIT 1;
      BEGIN;
      UPDATE mart.review_filter_facet_serving_v4
      SET facet_updated_at = current_timestamp
      WHERE project_id = (
          SELECT project_id
          FROM startup_probe_review_filter_facet_serving_v4
          LIMIT 1
        )
        AND review_config_hash = (
          SELECT review_config_hash
          FROM startup_probe_review_filter_facet_serving_v4
          LIMIT 1
        )
        AND snapshot_id = (
          SELECT snapshot_id
          FROM startup_probe_review_filter_facet_serving_v4
          LIMIT 1
        )
        AND summary_identity = (
          SELECT summary_identity
          FROM startup_probe_review_filter_facet_serving_v4
          LIMIT 1
        )
        AND facet_kind = (
          SELECT facet_kind
          FROM startup_probe_review_filter_facet_serving_v4
          LIMIT 1
        )
        AND facet_key = (
          SELECT facet_key
          FROM startup_probe_review_filter_facet_serving_v4
          LIMIT 1
        )
        AND facet_value = (
          SELECT facet_value
          FROM startup_probe_review_filter_facet_serving_v4
          LIMIT 1
        )
        AND summary_definition_version = (
          SELECT summary_definition_version
          FROM startup_probe_review_filter_facet_serving_v4
          LIMIT 1
        );
      COMMIT;
      BEGIN;
      UPDATE mart.review_filter_facet_serving_v4
      SET facet_updated_at = (
        SELECT facet_updated_at
        FROM startup_probe_review_filter_facet_serving_v4
        LIMIT 1
      )
      WHERE project_id = (
          SELECT project_id
          FROM startup_probe_review_filter_facet_serving_v4
          LIMIT 1
        )
        AND review_config_hash = (
          SELECT review_config_hash
          FROM startup_probe_review_filter_facet_serving_v4
          LIMIT 1
        )
        AND snapshot_id = (
          SELECT snapshot_id
          FROM startup_probe_review_filter_facet_serving_v4
          LIMIT 1
        )
        AND summary_identity = (
          SELECT summary_identity
          FROM startup_probe_review_filter_facet_serving_v4
          LIMIT 1
        )
        AND facet_kind = (
          SELECT facet_kind
          FROM startup_probe_review_filter_facet_serving_v4
          LIMIT 1
        )
        AND facet_key = (
          SELECT facet_key
          FROM startup_probe_review_filter_facet_serving_v4
          LIMIT 1
        )
        AND facet_value = (
          SELECT facet_value
          FROM startup_probe_review_filter_facet_serving_v4
          LIMIT 1
        )
        AND summary_definition_version = (
          SELECT summary_definition_version
          FROM startup_probe_review_filter_facet_serving_v4
          LIMIT 1
        );
      COMMIT;
      DROP TABLE IF EXISTS startup_probe_review_filter_facet_serving_v4;
    `,
    lowMemoryStartupPreflight: true,
    repairPrimaryKeyColumns: [
      'project_id',
      'review_config_hash',
      'snapshot_id',
      'summary_identity',
      'facet_kind',
      'facet_key',
      'facet_value',
      'summary_definition_version',
    ],
    schemaName: 'mart',
    tableName: 'review_filter_facet_serving_v4',
  },
  {
    duplicateKeySelectSql: `
      SELECT COUNT(*) AS duplicateCount
      FROM (
        SELECT
          project_id,
          review_config_hash,
          snapshot_id,
          search_identity,
          filter_option_identity,
          filter_kind,
          facet_key,
          option_value_key
        FROM mart.review_filter_option_serving_v4
        GROUP BY
          project_id,
          review_config_hash,
          snapshot_id,
          search_identity,
          filter_option_identity,
          filter_kind,
          facet_key,
          option_value_key
        HAVING COUNT(*) > 1
      )
    `,
    lowMemoryStartupPreflight: true,
    mutationProbeSql: `
      DROP TABLE IF EXISTS startup_probe_review_filter_option_serving_v4;
      CREATE TEMP TABLE startup_probe_review_filter_option_serving_v4 AS
      SELECT
        project_id,
        review_config_hash,
        snapshot_id,
        search_identity,
        filter_option_identity,
        filter_kind,
        facet_key,
        option_value_key,
        option_updated_at
      FROM mart.review_filter_option_serving_v4
      ORDER BY
        project_id,
        review_config_hash,
        snapshot_id,
        search_identity,
        filter_option_identity,
        filter_kind,
        facet_key,
        option_value_key
      LIMIT 1;
      BEGIN;
      UPDATE mart.review_filter_option_serving_v4
      SET option_updated_at = current_timestamp
      WHERE project_id = (
          SELECT project_id
          FROM startup_probe_review_filter_option_serving_v4
          LIMIT 1
        )
        AND review_config_hash = (
          SELECT review_config_hash
          FROM startup_probe_review_filter_option_serving_v4
          LIMIT 1
        )
        AND snapshot_id = (
          SELECT snapshot_id
          FROM startup_probe_review_filter_option_serving_v4
          LIMIT 1
        )
        AND search_identity = (
          SELECT search_identity
          FROM startup_probe_review_filter_option_serving_v4
          LIMIT 1
        )
        AND filter_option_identity = (
          SELECT filter_option_identity
          FROM startup_probe_review_filter_option_serving_v4
          LIMIT 1
        )
        AND filter_kind = (
          SELECT filter_kind
          FROM startup_probe_review_filter_option_serving_v4
          LIMIT 1
        )
        AND facet_key = (
          SELECT facet_key
          FROM startup_probe_review_filter_option_serving_v4
          LIMIT 1
        )
        AND option_value_key = (
          SELECT option_value_key
          FROM startup_probe_review_filter_option_serving_v4
          LIMIT 1
        );
      COMMIT;
      BEGIN;
      UPDATE mart.review_filter_option_serving_v4
      SET option_updated_at = (
        SELECT option_updated_at
        FROM startup_probe_review_filter_option_serving_v4
        LIMIT 1
      )
      WHERE project_id = (
          SELECT project_id
          FROM startup_probe_review_filter_option_serving_v4
          LIMIT 1
        )
        AND review_config_hash = (
          SELECT review_config_hash
          FROM startup_probe_review_filter_option_serving_v4
          LIMIT 1
        )
        AND snapshot_id = (
          SELECT snapshot_id
          FROM startup_probe_review_filter_option_serving_v4
          LIMIT 1
        )
        AND search_identity = (
          SELECT search_identity
          FROM startup_probe_review_filter_option_serving_v4
          LIMIT 1
        )
        AND filter_option_identity = (
          SELECT filter_option_identity
          FROM startup_probe_review_filter_option_serving_v4
          LIMIT 1
        )
        AND filter_kind = (
          SELECT filter_kind
          FROM startup_probe_review_filter_option_serving_v4
          LIMIT 1
        )
        AND facet_key = (
          SELECT facet_key
          FROM startup_probe_review_filter_option_serving_v4
          LIMIT 1
        )
        AND option_value_key = (
          SELECT option_value_key
          FROM startup_probe_review_filter_option_serving_v4
          LIMIT 1
        );
      COMMIT;
      DROP TABLE IF EXISTS startup_probe_review_filter_option_serving_v4;
    `,
    repairPrimaryKeyColumns: [
      'project_id',
      'review_config_hash',
      'snapshot_id',
      'search_identity',
      'filter_option_identity',
      'filter_kind',
      'facet_key',
      'option_value_key',
    ],
    schemaName: 'mart',
    tableName: 'review_filter_option_serving_v4',
  },
  {
    duplicateKeySelectSql: `
      SELECT COUNT(*) AS duplicateCount
      FROM (
        SELECT
          project_id,
          review_config_hash,
          snapshot_id,
          list_mode_key,
          article_id
        FROM mart.review_article_serving_v4
        GROUP BY
          project_id,
          review_config_hash,
          snapshot_id,
          list_mode_key,
          article_id
        HAVING COUNT(*) > 1
      )
    `,
    mutationProbeSql: `
      DROP TABLE IF EXISTS startup_probe_review_article_serving_v4;
      CREATE TEMP TABLE startup_probe_review_article_serving_v4 AS
      WITH failed_delete_ranges AS (
        SELECT
          project_id,
          chunk_start_key,
          chunk_end_key
        FROM app.review_rebuild_chunk_manifest
        WHERE projection_component = 'display'
          AND last_error LIKE '%Failed to delete all rows from index%'
        ORDER BY updated_at DESC, chunk_id ASC
        LIMIT 8
      ),
      failed_delete_rows AS (
        SELECT serving.*
        FROM mart.review_article_serving_v4 serving
        INNER JOIN failed_delete_ranges failed_range
          ON failed_range.project_id = serving.project_id
         AND (
              failed_range.chunk_start_key IS NULL
              OR serving.article_id >= failed_range.chunk_start_key
            )
         AND (
              failed_range.chunk_end_key IS NULL
              OR serving.article_id <= failed_range.chunk_end_key
            )
        ORDER BY
          serving.project_id,
          serving.review_config_hash,
          serving.snapshot_id,
          serving.list_mode_key,
          serving.article_id
        LIMIT 64
      ),
      fallback_row AS (
        SELECT serving.*
        FROM mart.review_article_serving_v4 serving
        WHERE NOT EXISTS (SELECT 1 FROM failed_delete_rows)
        ORDER BY
          serving.project_id,
          serving.review_config_hash,
          serving.snapshot_id,
          serving.list_mode_key,
          serving.article_id
        LIMIT 1
      )
      SELECT *
      FROM failed_delete_rows
      UNION ALL
      SELECT *
      FROM fallback_row;
      BEGIN;
      UPDATE mart.review_article_serving_v4
      SET serving_updated_at = current_timestamp
      WHERE EXISTS (
        SELECT 1
        FROM startup_probe_review_article_serving_v4 probe
        WHERE mart.review_article_serving_v4.project_id IS NOT DISTINCT FROM probe.project_id
          AND mart.review_article_serving_v4.review_config_hash IS NOT DISTINCT FROM probe.review_config_hash
          AND mart.review_article_serving_v4.snapshot_id IS NOT DISTINCT FROM probe.snapshot_id
          AND mart.review_article_serving_v4.list_mode_key IS NOT DISTINCT FROM probe.list_mode_key
          AND mart.review_article_serving_v4.article_id IS NOT DISTINCT FROM probe.article_id
      );
      DELETE FROM mart.review_article_serving_v4
      WHERE EXISTS (
        SELECT 1
        FROM startup_probe_review_article_serving_v4 probe
        WHERE mart.review_article_serving_v4.project_id IS NOT DISTINCT FROM probe.project_id
          AND mart.review_article_serving_v4.review_config_hash IS NOT DISTINCT FROM probe.review_config_hash
          AND mart.review_article_serving_v4.snapshot_id IS NOT DISTINCT FROM probe.snapshot_id
          AND mart.review_article_serving_v4.list_mode_key IS NOT DISTINCT FROM probe.list_mode_key
          AND mart.review_article_serving_v4.article_id IS NOT DISTINCT FROM probe.article_id
      );
      INSERT INTO mart.review_article_serving_v4 BY NAME
      SELECT *
      FROM startup_probe_review_article_serving_v4;
      COMMIT;
      DROP TABLE IF EXISTS startup_probe_review_article_serving_v4;
    `,
    schemaName: 'mart',
    tableName: 'review_article_serving_v4',
  },
  {
    duplicateKeySelectSql: `
      SELECT COUNT(*) AS duplicateCount
      FROM (
        SELECT
          project_id,
          review_config_hash,
          snapshot_id,
          list_mode_key,
          payload_kind,
          article_id,
          prompt_id
        FROM mart.review_article_judgment_detail_serving_v4
        GROUP BY
          project_id,
          review_config_hash,
          snapshot_id,
          list_mode_key,
          payload_kind,
          article_id,
          prompt_id
        HAVING COUNT(*) > 1
      )
    `,
    mutationProbeSql: `
      DROP TABLE IF EXISTS startup_probe_review_article_judgment_detail_serving_v4;
      CREATE TEMP TABLE startup_probe_review_article_judgment_detail_serving_v4 AS
      WITH failed_delete_ranges AS (
        SELECT
          project_id,
          chunk_start_key,
          chunk_end_key
        FROM app.review_rebuild_chunk_manifest
        WHERE projection_component = 'judgmentInputContent'
          AND (
            status = 'running'
            OR COALESCE(last_error, '') LIKE '%Failed to delete all rows from index%'
            OR COALESCE(last_error, '') LIKE '%DuckDB%'
          )
        ORDER BY updated_at DESC, chunk_id ASC
        LIMIT 8
      ),
      failed_delete_rows AS (
        SELECT detail.*
        FROM mart.review_article_judgment_detail_serving_v4 detail
        INNER JOIN failed_delete_ranges failed_range
          ON failed_range.project_id = detail.project_id
         AND (
              failed_range.chunk_start_key IS NULL
              OR detail.article_id >= failed_range.chunk_start_key
            )
         AND (
              failed_range.chunk_end_key IS NULL
              OR detail.article_id <= failed_range.chunk_end_key
            )
        ORDER BY
          detail.project_id,
          detail.review_config_hash,
          detail.snapshot_id,
          detail.list_mode_key,
          detail.payload_kind,
          detail.article_id,
          detail.prompt_id
        LIMIT 64
      ),
      fallback_row AS (
        SELECT detail.*
        FROM mart.review_article_judgment_detail_serving_v4 detail
        WHERE NOT EXISTS (SELECT 1 FROM failed_delete_rows)
        ORDER BY
          detail.project_id,
          detail.review_config_hash,
          detail.snapshot_id,
          detail.list_mode_key,
          detail.payload_kind,
          detail.article_id,
          detail.prompt_id
        LIMIT 1
      )
      SELECT *
      FROM failed_delete_rows
      UNION ALL
      SELECT *
      FROM fallback_row;
      BEGIN;
      UPDATE mart.review_article_judgment_detail_serving_v4
      SET detail_updated_at = current_timestamp
      WHERE EXISTS (
        SELECT 1
        FROM startup_probe_review_article_judgment_detail_serving_v4 probe
        WHERE mart.review_article_judgment_detail_serving_v4.project_id IS NOT DISTINCT FROM probe.project_id
          AND mart.review_article_judgment_detail_serving_v4.review_config_hash IS NOT DISTINCT FROM probe.review_config_hash
          AND mart.review_article_judgment_detail_serving_v4.snapshot_id IS NOT DISTINCT FROM probe.snapshot_id
          AND mart.review_article_judgment_detail_serving_v4.list_mode_key IS NOT DISTINCT FROM probe.list_mode_key
          AND mart.review_article_judgment_detail_serving_v4.payload_kind IS NOT DISTINCT FROM probe.payload_kind
          AND mart.review_article_judgment_detail_serving_v4.article_id IS NOT DISTINCT FROM probe.article_id
          AND mart.review_article_judgment_detail_serving_v4.prompt_id IS NOT DISTINCT FROM probe.prompt_id
      );
      DELETE FROM mart.review_article_judgment_detail_serving_v4
      WHERE EXISTS (
        SELECT 1
        FROM startup_probe_review_article_judgment_detail_serving_v4 probe
        WHERE mart.review_article_judgment_detail_serving_v4.project_id IS NOT DISTINCT FROM probe.project_id
          AND mart.review_article_judgment_detail_serving_v4.review_config_hash IS NOT DISTINCT FROM probe.review_config_hash
          AND mart.review_article_judgment_detail_serving_v4.snapshot_id IS NOT DISTINCT FROM probe.snapshot_id
          AND mart.review_article_judgment_detail_serving_v4.list_mode_key IS NOT DISTINCT FROM probe.list_mode_key
          AND mart.review_article_judgment_detail_serving_v4.payload_kind IS NOT DISTINCT FROM probe.payload_kind
          AND mart.review_article_judgment_detail_serving_v4.article_id IS NOT DISTINCT FROM probe.article_id
          AND mart.review_article_judgment_detail_serving_v4.prompt_id IS NOT DISTINCT FROM probe.prompt_id
      );
      INSERT INTO mart.review_article_judgment_detail_serving_v4 BY NAME
      SELECT *
      FROM startup_probe_review_article_judgment_detail_serving_v4;
      COMMIT;
      DROP TABLE IF EXISTS startup_probe_review_article_judgment_detail_serving_v4;
    `,
    lowMemoryStartupPreflight: true,
    repairPrimaryKeyColumns: [
      'project_id',
      'review_config_hash',
      'snapshot_id',
      'list_mode_key',
      'payload_kind',
      'article_id',
      'prompt_id',
    ],
    schemaName: 'mart',
    tableName: 'review_article_judgment_detail_serving_v4',
  },
  {
    duplicateKeySelectSql: `
      SELECT COUNT(*) AS duplicateCount
      FROM (
        SELECT
          project_id,
          search_identity,
          project_scope_identity,
          snapshot_id,
          token,
          article_id
        FROM mart.review_title_search_serving_v4
        GROUP BY
          project_id,
          search_identity,
          project_scope_identity,
          snapshot_id,
          token,
          article_id
        HAVING COUNT(*) > 1
      )
    `,
    lowMemoryStartupPreflight: true,
    mutationProbeSql: `
      DROP TABLE IF EXISTS startup_probe_review_title_search_serving_v4;
      CREATE TEMP TABLE startup_probe_review_title_search_serving_v4 AS
      SELECT
        project_id,
        search_identity,
        project_scope_identity,
        snapshot_id,
        token,
        article_id,
        search_updated_at
      FROM mart.review_title_search_serving_v4
      ORDER BY
        project_id,
        search_identity,
        project_scope_identity,
        snapshot_id,
        token,
        article_id
      LIMIT 1;
      BEGIN;
      UPDATE mart.review_title_search_serving_v4
      SET search_updated_at = current_timestamp
      WHERE project_id = (
          SELECT project_id
          FROM startup_probe_review_title_search_serving_v4
          LIMIT 1
        )
        AND search_identity = (
          SELECT search_identity
          FROM startup_probe_review_title_search_serving_v4
          LIMIT 1
        )
        AND project_scope_identity = (
          SELECT project_scope_identity
          FROM startup_probe_review_title_search_serving_v4
          LIMIT 1
        )
        AND snapshot_id = (
          SELECT snapshot_id
          FROM startup_probe_review_title_search_serving_v4
          LIMIT 1
        )
        AND token = (
          SELECT token
          FROM startup_probe_review_title_search_serving_v4
          LIMIT 1
        )
        AND article_id = (
          SELECT article_id
          FROM startup_probe_review_title_search_serving_v4
          LIMIT 1
        );
      COMMIT;
      BEGIN;
      UPDATE mart.review_title_search_serving_v4
      SET search_updated_at = (
        SELECT search_updated_at
        FROM startup_probe_review_title_search_serving_v4
        LIMIT 1
      )
      WHERE project_id = (
          SELECT project_id
          FROM startup_probe_review_title_search_serving_v4
          LIMIT 1
        )
        AND search_identity = (
          SELECT search_identity
          FROM startup_probe_review_title_search_serving_v4
          LIMIT 1
        )
        AND project_scope_identity = (
          SELECT project_scope_identity
          FROM startup_probe_review_title_search_serving_v4
          LIMIT 1
        )
        AND snapshot_id = (
          SELECT snapshot_id
          FROM startup_probe_review_title_search_serving_v4
          LIMIT 1
        )
        AND token = (
          SELECT token
          FROM startup_probe_review_title_search_serving_v4
          LIMIT 1
        )
        AND article_id = (
          SELECT article_id
          FROM startup_probe_review_title_search_serving_v4
          LIMIT 1
        );
      COMMIT;
      DROP TABLE IF EXISTS startup_probe_review_title_search_serving_v4;
    `,
    repairPrimaryKeyColumns: [
      'project_id',
      'search_identity',
      'project_scope_identity',
      'snapshot_id',
      'token',
      'article_id',
    ],
    schemaName: 'mart',
    tableName: 'review_title_search_serving_v4',
  },
  {
    duplicateKeySelectSql: `
      SELECT COUNT(*) AS duplicateCount
      FROM (
        SELECT
          project_id,
          review_config_hash,
          snapshot_id,
          queue_kind,
          priority_bucket,
          activity_sort_at,
          article_id,
          prompt_id,
          queue_identity
        FROM mart.review_unassessed_queue_serving_v4
        GROUP BY
          project_id,
          review_config_hash,
          snapshot_id,
          queue_kind,
          priority_bucket,
          activity_sort_at,
          article_id,
          prompt_id,
          queue_identity
        HAVING COUNT(*) > 1
      )
    `,
    lowMemoryStartupPreflight: true,
    mutationProbeSql: `
      DROP TABLE IF EXISTS startup_probe_review_unassessed_queue_serving_v4;
      CREATE TEMP TABLE startup_probe_review_unassessed_queue_serving_v4 AS
      SELECT
        project_id,
        review_config_hash,
        snapshot_id,
        queue_kind,
        priority_bucket,
        activity_sort_at,
        article_id,
        prompt_id,
        queue_identity,
        queue_updated_at
      FROM mart.review_unassessed_queue_serving_v4
      ORDER BY
        project_id,
        review_config_hash,
        snapshot_id,
        queue_kind,
        priority_bucket,
        activity_sort_at,
        article_id,
        prompt_id,
        queue_identity
      LIMIT 1;
      BEGIN;
      UPDATE mart.review_unassessed_queue_serving_v4
      SET queue_updated_at = current_timestamp
      WHERE project_id = (
          SELECT project_id
          FROM startup_probe_review_unassessed_queue_serving_v4
          LIMIT 1
        )
        AND review_config_hash = (
          SELECT review_config_hash
          FROM startup_probe_review_unassessed_queue_serving_v4
          LIMIT 1
        )
        AND snapshot_id = (
          SELECT snapshot_id
          FROM startup_probe_review_unassessed_queue_serving_v4
          LIMIT 1
        )
        AND queue_kind = (
          SELECT queue_kind
          FROM startup_probe_review_unassessed_queue_serving_v4
          LIMIT 1
        )
        AND priority_bucket = (
          SELECT priority_bucket
          FROM startup_probe_review_unassessed_queue_serving_v4
          LIMIT 1
        )
        AND activity_sort_at = (
          SELECT activity_sort_at
          FROM startup_probe_review_unassessed_queue_serving_v4
          LIMIT 1
        )
        AND article_id = (
          SELECT article_id
          FROM startup_probe_review_unassessed_queue_serving_v4
          LIMIT 1
        )
        AND prompt_id = (
          SELECT prompt_id
          FROM startup_probe_review_unassessed_queue_serving_v4
          LIMIT 1
        )
        AND queue_identity = (
          SELECT queue_identity
          FROM startup_probe_review_unassessed_queue_serving_v4
          LIMIT 1
        );
      COMMIT;
      BEGIN;
      UPDATE mart.review_unassessed_queue_serving_v4
      SET queue_updated_at = (
        SELECT queue_updated_at
        FROM startup_probe_review_unassessed_queue_serving_v4
        LIMIT 1
      )
      WHERE project_id = (
          SELECT project_id
          FROM startup_probe_review_unassessed_queue_serving_v4
          LIMIT 1
        )
        AND review_config_hash = (
          SELECT review_config_hash
          FROM startup_probe_review_unassessed_queue_serving_v4
          LIMIT 1
        )
        AND snapshot_id = (
          SELECT snapshot_id
          FROM startup_probe_review_unassessed_queue_serving_v4
          LIMIT 1
        )
        AND queue_kind = (
          SELECT queue_kind
          FROM startup_probe_review_unassessed_queue_serving_v4
          LIMIT 1
        )
        AND priority_bucket = (
          SELECT priority_bucket
          FROM startup_probe_review_unassessed_queue_serving_v4
          LIMIT 1
        )
        AND activity_sort_at = (
          SELECT activity_sort_at
          FROM startup_probe_review_unassessed_queue_serving_v4
          LIMIT 1
        )
        AND article_id = (
          SELECT article_id
          FROM startup_probe_review_unassessed_queue_serving_v4
          LIMIT 1
        )
        AND prompt_id = (
          SELECT prompt_id
          FROM startup_probe_review_unassessed_queue_serving_v4
          LIMIT 1
        )
        AND queue_identity = (
          SELECT queue_identity
          FROM startup_probe_review_unassessed_queue_serving_v4
          LIMIT 1
        );
      COMMIT;
      DROP TABLE IF EXISTS startup_probe_review_unassessed_queue_serving_v4;
    `,
    repairPrimaryKeyColumns: [
      'project_id',
      'review_config_hash',
      'snapshot_id',
      'queue_kind',
      'priority_bucket',
      'activity_sort_at',
      'article_id',
      'prompt_id',
      'queue_identity',
    ],
    schemaName: 'mart',
    tableName: 'review_unassessed_queue_serving_v4',
  },
  {
    duplicateKeySelectSql: `
      SELECT COUNT(*) AS duplicateCount
      FROM (
        SELECT
          project_id,
          review_config_hash,
          snapshot_id,
          filter_kind,
          filter_value,
          list_mode_key,
          article_id
        FROM mart.review_article_filter_posting_serving_v4
        GROUP BY
          project_id,
          review_config_hash,
          snapshot_id,
          filter_kind,
          filter_value,
          list_mode_key,
          article_id
        HAVING COUNT(*) > 1
      )
    `,
    mutationProbeSql: `
      DROP TABLE IF EXISTS startup_probe_review_article_filter_posting_serving_v4;
      CREATE TEMP TABLE startup_probe_review_article_filter_posting_serving_v4 AS
      SELECT
        project_id,
        review_config_hash,
        snapshot_id,
        filter_kind,
        filter_value,
        list_mode_key,
        article_id,
        posting_updated_at
      FROM mart.review_article_filter_posting_serving_v4
      ORDER BY
        project_id,
        review_config_hash,
        snapshot_id,
        filter_kind,
        filter_value,
        list_mode_key,
        article_id
      LIMIT 1;
      BEGIN;
      UPDATE mart.review_article_filter_posting_serving_v4
      SET posting_updated_at = current_timestamp
      WHERE project_id = (
          SELECT project_id
          FROM startup_probe_review_article_filter_posting_serving_v4
          LIMIT 1
        )
        AND review_config_hash = (
          SELECT review_config_hash
          FROM startup_probe_review_article_filter_posting_serving_v4
          LIMIT 1
        )
        AND snapshot_id = (
          SELECT snapshot_id
          FROM startup_probe_review_article_filter_posting_serving_v4
          LIMIT 1
        )
        AND filter_kind = (
          SELECT filter_kind
          FROM startup_probe_review_article_filter_posting_serving_v4
          LIMIT 1
        )
        AND filter_value = (
          SELECT filter_value
          FROM startup_probe_review_article_filter_posting_serving_v4
          LIMIT 1
        )
        AND list_mode_key = (
          SELECT list_mode_key
          FROM startup_probe_review_article_filter_posting_serving_v4
          LIMIT 1
        )
        AND article_id = (
          SELECT article_id
          FROM startup_probe_review_article_filter_posting_serving_v4
          LIMIT 1
        );
      COMMIT;
      BEGIN;
      UPDATE mart.review_article_filter_posting_serving_v4
      SET posting_updated_at = (
        SELECT posting_updated_at
        FROM startup_probe_review_article_filter_posting_serving_v4
        LIMIT 1
      )
      WHERE project_id = (
          SELECT project_id
          FROM startup_probe_review_article_filter_posting_serving_v4
          LIMIT 1
        )
        AND review_config_hash = (
          SELECT review_config_hash
          FROM startup_probe_review_article_filter_posting_serving_v4
          LIMIT 1
        )
        AND snapshot_id = (
          SELECT snapshot_id
          FROM startup_probe_review_article_filter_posting_serving_v4
          LIMIT 1
        )
        AND filter_kind = (
          SELECT filter_kind
          FROM startup_probe_review_article_filter_posting_serving_v4
          LIMIT 1
        )
        AND filter_value = (
          SELECT filter_value
          FROM startup_probe_review_article_filter_posting_serving_v4
          LIMIT 1
        )
        AND list_mode_key = (
          SELECT list_mode_key
          FROM startup_probe_review_article_filter_posting_serving_v4
          LIMIT 1
        )
        AND article_id = (
          SELECT article_id
          FROM startup_probe_review_article_filter_posting_serving_v4
          LIMIT 1
        );
      COMMIT;
      DROP TABLE IF EXISTS startup_probe_review_article_filter_posting_serving_v4;
    `,
    lowMemoryStartupPreflight: true,
    repairPrimaryKeyColumns: [
      'project_id',
      'review_config_hash',
      'snapshot_id',
      'filter_kind',
      'filter_value',
      'list_mode_key',
      'article_id',
    ],
    schemaName: 'mart',
    tableName: 'review_article_filter_posting_serving_v4',
  },
  {
    duplicateKeySelectSql: `
      SELECT COUNT(*) AS duplicateCount
      FROM (
        SELECT
          project_id,
          review_config_hash,
          snapshot_id,
          filter_kind,
          filter_value,
          list_mode_key
        FROM mart.review_filter_posting_stats_v4
        GROUP BY
          project_id,
          review_config_hash,
          snapshot_id,
          filter_kind,
          filter_value,
          list_mode_key
        HAVING COUNT(*) > 1
      )
    `,
    mutationProbeSql: `
      DROP TABLE IF EXISTS startup_probe_review_filter_posting_stats_v4;
      CREATE TEMP TABLE startup_probe_review_filter_posting_stats_v4 AS
      SELECT
        project_id,
        review_config_hash,
        snapshot_id,
        filter_kind,
        filter_value,
        list_mode_key,
        stats_updated_at
      FROM mart.review_filter_posting_stats_v4
      ORDER BY
        project_id,
        review_config_hash,
        snapshot_id,
        filter_kind,
        filter_value,
        list_mode_key
      LIMIT 1;
      BEGIN;
      UPDATE mart.review_filter_posting_stats_v4
      SET stats_updated_at = current_timestamp
      WHERE project_id = (
          SELECT project_id
          FROM startup_probe_review_filter_posting_stats_v4
          LIMIT 1
        )
        AND review_config_hash = (
          SELECT review_config_hash
          FROM startup_probe_review_filter_posting_stats_v4
          LIMIT 1
        )
        AND snapshot_id = (
          SELECT snapshot_id
          FROM startup_probe_review_filter_posting_stats_v4
          LIMIT 1
        )
        AND filter_kind = (
          SELECT filter_kind
          FROM startup_probe_review_filter_posting_stats_v4
          LIMIT 1
        )
        AND filter_value = (
          SELECT filter_value
          FROM startup_probe_review_filter_posting_stats_v4
          LIMIT 1
        )
        AND list_mode_key = (
          SELECT list_mode_key
          FROM startup_probe_review_filter_posting_stats_v4
          LIMIT 1
        );
      COMMIT;
      BEGIN;
      UPDATE mart.review_filter_posting_stats_v4
      SET stats_updated_at = (
        SELECT stats_updated_at
        FROM startup_probe_review_filter_posting_stats_v4
        LIMIT 1
      )
      WHERE project_id = (
          SELECT project_id
          FROM startup_probe_review_filter_posting_stats_v4
          LIMIT 1
        )
        AND review_config_hash = (
          SELECT review_config_hash
          FROM startup_probe_review_filter_posting_stats_v4
          LIMIT 1
        )
        AND snapshot_id = (
          SELECT snapshot_id
          FROM startup_probe_review_filter_posting_stats_v4
          LIMIT 1
        )
        AND filter_kind = (
          SELECT filter_kind
          FROM startup_probe_review_filter_posting_stats_v4
          LIMIT 1
        )
        AND filter_value = (
          SELECT filter_value
          FROM startup_probe_review_filter_posting_stats_v4
          LIMIT 1
        )
        AND list_mode_key = (
          SELECT list_mode_key
          FROM startup_probe_review_filter_posting_stats_v4
          LIMIT 1
        );
      COMMIT;
      DROP TABLE IF EXISTS startup_probe_review_filter_posting_stats_v4;
    `,
    lowMemoryStartupPreflight: true,
    repairPrimaryKeyColumns: [
      'project_id',
      'review_config_hash',
      'snapshot_id',
      'filter_kind',
      'filter_value',
      'list_mode_key',
    ],
    schemaName: 'mart',
    tableName: 'review_filter_posting_stats_v4',
  },
] as const
const enforcedForegroundDuckdbOperations = new Set<DuckdbWorkloadOperation>([
  'mainQuery',
  'mainStatement',
  'transaction',
])

declare global {
  var __forskaDuckdbServiceState: DuckdbServiceState | undefined
}

const duckdbSnapshotDirectory = join(tmpdir(), 'forska-duckdb-studio')
const getDuckdbAppendLaneCountValue = () => {
  return Math.max(1, Number(getEnv().DUCKDB_APPEND_LANE_COUNT ?? 2))
}

const getInitialDuckdbAppendQueues = (appendLaneCount: number) => {
  return Array.from({length: appendLaneCount}, () => {
    return Promise.resolve()
  })
}

const getInitialDuckdbAppendLaneMetrics = (appendLaneCount: number) => {
  return Array.from({length: appendLaneCount}, () => {
    return 0
  })
}

const getDuckdbServiceState = () => {
  globalThis.__forskaDuckdbServiceState ??= {
    appendBarrier: null,
    appendConnections: [],
    appendLastDurationMs: null,
    appendMaxQueueDepthByLane: getInitialDuckdbAppendLaneMetrics(getDuckdbAppendLaneCountValue()),
    appendPendingCountByLane: getInitialDuckdbAppendLaneMetrics(getDuckdbAppendLaneCountValue()),
    appendQueues: getInitialDuckdbAppendQueues(getDuckdbAppendLaneCountValue()),
    appendTotalBatchesCompleted: 0,
    appendTotalBatchesStarted: 0,
    appendTotalDurationMs: 0,
    backgroundConnection: null,
    backgroundLastDurationMs: null,
    backgroundLastWaitMs: null,
    backgroundMaxQueueDepth: 0,
    backgroundPendingCount: 0,
    backgroundQueue: Promise.resolve(),
    backgroundTasksCompleted: 0,
    backgroundTasksStarted: 0,
    backgroundTotalDurationMs: 0,
    backgroundTotalWaitMs: 0,
    controlConnection: null,
    controlTransactionDepth: 0,
    duckdbInstance: null,
    duckdbLastDurationMs: null,
    duckdbLastWaitMs: null,
    duckdbMaxQueueDepth: 0,
    duckdbPendingCount: 0,
    duckdbQueue: Promise.resolve(),
    duckdbRuntimeConfig: null,
    duckdbTasksCompleted: 0,
    duckdbTasksStarted: 0,
    duckdbTotalDurationMs: 0,
    duckdbTotalWaitMs: 0,
    duckdbWorkloadMetrics: [],
    nextAppendLaneIndex: 0,
    shutdownHooksRegistered: false,
    startupPromise: null,
  }

  return globalThis.__forskaDuckdbServiceState
}

const duckdbServiceState = getDuckdbServiceState()

const getTrimmedValue = (value: string | null | undefined) => {
  const normalized = String(value ?? '').trim()
  return normalized === '' ? null : normalized
}

const getDuckdbThreadCountValue = (memoryLimit: string) => {
  const memoryLimitMiB = parseDuckdbMemoryLimitToMiB(memoryLimit)

  if (memoryLimitMiB !== null && memoryLimitMiB <= 6400) {
    return '1'
  }

  const memoryBoundThreadCount =
    memoryLimitMiB === null || memoryLimitMiB > 8192 ? 8 : memoryLimitMiB > 4096 ? 4 : memoryLimitMiB > 2048 ? 2 : 1

  return String(Math.max(1, Math.min(availableParallelism(), memoryBoundThreadCount)))
}

const shouldSerializeDuckdbConcurrentWork = (memoryLimit: string) => {
  const memoryLimitMiB = parseDuckdbMemoryLimitToMiB(memoryLimit)
  return memoryLimitMiB !== null && memoryLimitMiB <= 6400
}

const getDuckdbCheckpointThresholdValue = (memoryLimit: string) => {
  const memoryLimitMiB = parseDuckdbMemoryLimitToMiB(memoryLimit)

  if (memoryLimitMiB === null) {
    return `${duckdbCheckpointThresholdMaxMiB}MiB`
  }

  if (memoryLimitMiB >= 4096 && memoryLimitMiB <= 6400) {
    return `${duckdbCheckpointThresholdMaxMiB}MiB`
  }

  const thresholdMiB = Math.max(
    duckdbCheckpointThresholdMinMiB,
    Math.min(duckdbCheckpointThresholdMaxMiB, Math.floor(memoryLimitMiB / 4)),
  )

  return `${thresholdMiB}MiB`
}

const getDuckdbRuntimeConfigValue = () => {
  if (duckdbServiceState.duckdbRuntimeConfig) {
    return duckdbServiceState.duckdbRuntimeConfig
  }

  const env = getEnv()
  const memoryLimit = env.DUCKDB_MEMORY_LIMIT

  duckdbServiceState.duckdbRuntimeConfig = {
    appendLaneCount: getDuckdbAppendLaneCountValue(),
    binary: '@duckdb/node-api',
    checkpointThreshold: getDuckdbCheckpointThresholdValue(memoryLimit),
    databasePath: env.DUCKDB_PATH,
    memoryLimit,
    preserveInsertionOrder: false,
    serializeConcurrentWork: canCurrentServerOwnDuckdb() || shouldSerializeDuckdbConcurrentWork(memoryLimit),
    tempDirectory: getTrimmedValue(env.DUCKDB_TEMP_DIRECTORY),
    threads: getDuckdbThreadCountValue(memoryLimit),
  }

  return duckdbServiceState.duckdbRuntimeConfig
}

const ensureDuckdbRuntimeDirectories = (runtimeConfig: DuckdbRuntimeConfig) => {
  ensureDuckdbPathDirectory(runtimeConfig.databasePath)
  return runtimeConfig.tempDirectory === null ? runtimeConfig : createDuckdbTempDirectory(runtimeConfig)
}

const createDuckdbTempDirectory = (runtimeConfig: DuckdbRuntimeConfig) => {
  mkdirSync(runtimeConfig.tempDirectory ?? '', {recursive: true})
  return runtimeConfig
}

const getDuckdbInstanceOptions = (runtimeConfig: DuckdbRuntimeConfig): Record<string, string> => {
  return runtimeConfig.tempDirectory === null
    ? {
        checkpoint_threshold: runtimeConfig.checkpointThreshold,
        memory_limit: runtimeConfig.memoryLimit,
        preserve_insertion_order: String(runtimeConfig.preserveInsertionOrder),
        threads: runtimeConfig.threads,
      }
    : {
        checkpoint_threshold: runtimeConfig.checkpointThreshold,
        memory_limit: runtimeConfig.memoryLimit,
        preserve_insertion_order: String(runtimeConfig.preserveInsertionOrder),
        temp_directory: runtimeConfig.tempDirectory,
        threads: runtimeConfig.threads,
      }
}

const getDuckdbIndexedTableRepairInstanceOptions = (runtimeConfig: DuckdbRuntimeConfig): Record<string, string> => {
  return {...getDuckdbInstanceOptions(runtimeConfig), checkpoint_threshold: '8GB'}
}

export const getReadOnlyDuckdbRuntimeOptions = (input: ReadOnlyDuckdbRuntimeOptionsInput = {}) => {
  const runtimeConfig = getDuckdbRuntimeConfigValue()
  const tempDirectory = input.tempDirectory ?? runtimeConfig.tempDirectory
  const baseOptions = {
    access_mode: input.accessMode ?? 'READ_ONLY',
    checkpoint_threshold: runtimeConfig.checkpointThreshold,
    memory_limit: input.memoryLimit ?? runtimeConfig.memoryLimit,
    preserve_insertion_order: String(runtimeConfig.preserveInsertionOrder),
    threads: input.threads ?? runtimeConfig.threads,
  }

  return tempDirectory === null ? baseOptions : {...baseOptions, temp_directory: tempDirectory}
}

export const getMaintenanceDuckdbWorkloadContext = (taskName: string): DuckdbWorkloadContext => {
  return {
    allowsTempSpill: true,
    fallbackIntent: 'reject',
    routeOrJobKey: `maintenance.${taskName}`,
    workloadClass: 'maintenance',
  }
}

const getDirectorySizeSnapshot = (directoryPath: string): {fileCount: number; totalBytes: number} => {
  return readdirSync(directoryPath, {withFileTypes: true}).reduce(
    (snapshot, entry) => {
      const entryPath = join(directoryPath, entry.name)
      const entrySnapshot = entry.isDirectory()
        ? getDirectorySizeSnapshot(entryPath)
        : {fileCount: 1, totalBytes: statSync(entryPath).size}

      return {
        fileCount: snapshot.fileCount + entrySnapshot.fileCount,
        totalBytes: snapshot.totalBytes + entrySnapshot.totalBytes,
      }
    },
    {fileCount: 0, totalBytes: 0},
  )
}

const getErrorMessage = (value: unknown): string | null => {
  if (typeof value === 'string') {
    return value
  }

  if (value instanceof Error) {
    return value.message
  }

  return typeof value === 'object' && value !== null && 'message' in value && typeof value.message === 'string'
    ? value.message
    : null
}

const getEffectFiberFailure = (value: unknown): EffectFiberFailure | null => {
  if (typeof value !== 'object' || value === null) {
    return null
  }

  const causeSymbol = Object.getOwnPropertySymbols(value).find((symbol) => {
    return String(symbol) === 'Symbol(effect/Runtime/FiberFailure/Cause)'
  })

  return causeSymbol === undefined ? null : ((value as Record<PropertyKey, unknown>)[causeSymbol] as EffectFiberFailure)
}

const getEffectFailureMessage = (value: unknown): string | null => {
  const fiberFailure = getEffectFiberFailure(value)
  const failure = fiberFailure?.error ?? fiberFailure?.failure

  return getErrorMessage(failure?.cause) ?? getErrorMessage(failure?.error) ?? getErrorMessage(failure?.message)
}

const getNormalizedDuckdbError = (error: unknown): Error => {
  if (error instanceof Error) {
    const effectFailureMessage = getEffectFailureMessage(error)
    const combinedMessage =
      effectFailureMessage !== null && effectFailureMessage !== error.message
        ? `${error.message} -- ${effectFailureMessage}`
        : error.message

    return combinedMessage === error.message ? error : new Error(combinedMessage)
  }

  return new Error(getErrorMessage(error) ?? String(error))
}

const getChainedDuckdbError = (error: unknown, nextError: unknown, context: string): Error => {
  const normalizedError = getNormalizedDuckdbError(error)
  const normalizedNextError = getNormalizedDuckdbError(nextError)
  const combinedMessage =
    normalizedNextError.message === normalizedError.message
      ? normalizedError.message
      : `${normalizedError.message} -- ${context}: ${normalizedNextError.message}`

  return combinedMessage === normalizedError.message ? normalizedError : new Error(combinedMessage)
}

let duckdbFatalRecoveryPromise: Promise<void> | null = null
let duckdbLastMutatingStatementTargetTable: string | null = null
let duckdbShutdownInProgress = false

const isDuckdbRestartRequiredError = (error: unknown) => {
  const message = getNormalizedDuckdbError(error).message

  return duckdbRestartRequiredErrorFragments.some((fragment) => {
    return message.includes(fragment)
  })
}

const isDuckdbAbortedTransactionError = (error: unknown) => {
  const message = getNormalizedDuckdbError(error).message

  return duckdbAbortedTransactionErrorFragments.some((fragment) => {
    return message.includes(fragment)
  })
}

const getCompactDuckdbErrorMessage = (error: unknown) => {
  const message = getNormalizedDuckdbError(error).message.replace(/\s+/g, ' ').trim()
  return message.length <= 280 ? message : `${message.slice(0, 277)}...`
}

const getDuckdbStatementPreview = (statement: string) => {
  const normalizedStatement = statement.replace(/\s+/g, ' ').trim()
  return normalizedStatement.length <= 280 ? normalizedStatement : `${normalizedStatement.slice(0, 277)}...`
}

const getDuckdbRecoveryPathPart = () => {
  return `${new Date().toISOString().replaceAll(':', '-')}.${randomUUID()}`
}

const isMissingFileError = (error: unknown) => {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

const pathExists = async (filePath: string) => {
  try {
    await access(filePath)
    return true
  } catch (error) {
    if (isMissingFileError(error)) {
      return false
    }

    throw error
  }
}

const getDuckdbErrorWithStatementContext = (error: unknown, label: string, statement: string) => {
  const normalizedError = getNormalizedDuckdbError(error)
  const statementContext = `${label}: ${getDuckdbStatementPreview(statement)}`

  return normalizedError.message.includes(statementContext)
    ? normalizedError
    : new Error(`${normalizedError.message} -- ${statementContext}`)
}

const withDuckdbStatementErrorContext = async <T>({
  label,
  statement,
  work,
}: {
  label: string
  statement: string
  work: () => Promise<T>
}): Promise<T> => {
  try {
    return await work()
  } catch (error) {
    throw getDuckdbErrorWithStatementContext(error, label, statement)
  }
}

const recoverDuckdbRuntimeAfterFatalError = async (error: unknown, options: CloseDuckdbServiceOptions = {}) => {
  if (duckdbFatalRecoveryPromise !== null) {
    return duckdbFatalRecoveryPromise
  }

  markDuckdbStartupRepairForFatalIndexedTableError(error)

  writeRuntimeOperatorLogEvent({
    attrs: {error},
    event: 'duckdb.recovery.restart',
    message: '[duckdb] restarting embedded runtime after fatal invalidation',
    severity: 'WARN',
    terminalArgs: [getCompactDuckdbErrorMessage(error)],
  })

  duckdbFatalRecoveryPromise = closeDuckdbServiceDirect({
    checkpointBeforeClose: false,
    releaseOwnerLease: false,
    ...options,
  })
    .catch((closeError) => {
      writeRuntimeFailureLogEvent({
        attrs: {closeError},
        event: 'duckdb.recovery.close-failure',
        message: '[duckdb] failed to close embedded runtime during fatal recovery',
        severity: 'ERROR',
        terminalArgs: [closeError],
      })
    })
    .finally(() => {
      duckdbFatalRecoveryPromise = null
    })

  return duckdbFatalRecoveryPromise
}

const markDuckdbStartupRepairForFatalIndexedTableError = (error: unknown) => {
  const normalizedError = getNormalizedDuckdbError(error)

  if (!normalizedError.message.includes('Failed to delete all rows from index')) {
    return
  }

  const runtimeConfig = duckdbServiceState.duckdbRuntimeConfig

  if (runtimeConfig === null || runtimeConfig.databasePath === ':memory:') {
    return
  }

  const markerPath = getDuckdbStartupPreflightActiveRepairSpecPath(runtimeConfig)
  const repairSpec = getDuckdbStartupRepairSpecForFatalIndexedTableError(
    normalizedError,
    duckdbLastMutatingStatementTargetTable,
  )

  mkdirSync(`${runtimeConfig.databasePath}.startup-recovery`, {recursive: true})
  writeFileSync(
    markerPath,
    JSON.stringify({
      phase: 'runtime-fatal-index-delete',
      schemaName: repairSpec.schemaName,
      tableName: repairSpec.tableName,
    }),
  )
  writeRuntimeOperatorLogEvent({
    attrs: {
      databasePath: runtimeConfig.databasePath,
      error: normalizedError.message,
      markerPath,
      repairedTable: `${repairSpec.schemaName}.${repairSpec.tableName}`,
    },
    event: 'duckdb.recovery.indexed-table-repair-marker',
    message: '[duckdb] marked indexed table repair for next startup after fatal index-delete error',
    severity: 'WARN',
    terminalArgs: [`marker=${markerPath}`],
  })
}

const getDuckdbStartupRepairSpecForTableName = (tableName: string | null) => {
  if (tableName === null) {
    return undefined
  }

  return duckdbStartupIndexedTableRepairSpecs.find((spec) => {
    return tableName === `${spec.schemaName}.${spec.tableName}` || tableName === spec.tableName
  })
}

const getDuckdbStartupRepairSpecForFatalIndexedTableError = (error: Error, lastMutatingTargetTable: string | null) => {
  const message = error.message
  const matchedSpec = duckdbStartupIndexedTableRepairSpecs.find((spec) => {
    return message.includes(`${spec.schemaName}.${spec.tableName}`)
  })

  if (matchedSpec !== undefined) {
    return matchedSpec
  }

  const unqualifiedMessageSpec = duckdbStartupIndexedTableRepairSpecs.find((spec) => {
    return message.includes(spec.tableName)
  })

  if (unqualifiedMessageSpec !== undefined) {
    return unqualifiedMessageSpec
  }

  const fallbackSpec = duckdbStartupIndexedTableRepairSpecs.find((spec) => {
    return spec.schemaName === 'app' && spec.tableName === 'review_rebuild_chunk_manifest'
  })

  if (fallbackSpec === undefined) {
    throw new Error('missing DuckDB startup repair fallback spec')
  }

  return getDuckdbStartupRepairSpecForTableName(lastMutatingTargetTable) ?? fallbackSpec
}

const isDuckdbStartupRetryableError = (error: unknown) => {
  const message = getNormalizedDuckdbError(error).message

  return duckdbStartupRetryableErrorFragments.some((fragment) => {
    return message.includes(fragment)
  })
}

const isDuckdbWalReplayRecoveryError = (error: unknown) => {
  const message = getNormalizedDuckdbError(error).message

  return duckdbWalReplayRecoveryErrorFragments.every((fragment) => {
    return message.includes(fragment)
  })
}

const isDuckdbTransientFileLockError = (message: string) => {
  return message.includes('Could not set lock on file') && message.includes('Conflicting lock is held')
}

const sleepMs = (delayMs: number) => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs)
  })
}

const copyDuckdbDatabaseBeforeWalRecovery = async ({
  databaseBackupPath,
  databasePath,
}: {
  databaseBackupPath: string
  databasePath: string
}) => {
  if (!(await pathExists(databasePath))) {
    return null
  }

  try {
    await copyFile(databasePath, databaseBackupPath, fsConstants.COPYFILE_FICLONE)
  } catch {
    await copyFile(databasePath, databaseBackupPath)
  }

  return databaseBackupPath
}

const quarantineFailedDuckdbWalReplay = async (
  runtimeConfig: DuckdbRuntimeConfig,
  error: unknown,
  {
    event = 'duckdb.startup.wal-quarantine',
    message = '[duckdb] quarantined failed startup WAL replay; retrying from last checkpoint',
    recovery = 'wal-quarantine-retry-from-last-checkpoint',
    walFileSuffix = 'failed-replay',
  }: {event?: string; message?: string; recovery?: string; walFileSuffix?: string} = {},
) => {
  if (runtimeConfig.databasePath === ':memory:') {
    throw new Error('DuckDB WAL replay recovery is unavailable for :memory: databases')
  }

  const walPath = `${runtimeConfig.databasePath}.wal`

  if (!(await pathExists(walPath))) {
    throw new Error(`DuckDB WAL replay recovery could not find ${walPath}`)
  }

  const recoveryPathPart = getDuckdbRecoveryPathPart()
  const recoveryDirectory = `${runtimeConfig.databasePath}.startup-recovery`
  const databaseBackupPath = join(recoveryDirectory, `${recoveryPathPart}.duckdb`)
  const walQuarantinePath = join(recoveryDirectory, `${recoveryPathPart}.${walFileSuffix}.wal`)
  const manifestPath = join(recoveryDirectory, `${recoveryPathPart}.recovery.json`)

  await mkdir(recoveryDirectory, {recursive: true})
  const preservedDatabasePath = await copyDuckdbDatabaseBeforeWalRecovery({
    databaseBackupPath,
    databasePath: runtimeConfig.databasePath,
  })
  await rename(walPath, walQuarantinePath)
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        checkpointSourcePath: runtimeConfig.databasePath,
        error: getCompactDuckdbErrorMessage(error),
        preservedDatabasePath,
        recoveredAt: new Date().toISOString(),
        recovery,
        walPath,
        walQuarantinePath,
      },
      null,
      2,
    ),
  )
  writeRuntimeFailureLogEvent({
    attrs: {
      databasePath: runtimeConfig.databasePath,
      error,
      manifestPath,
      preservedDatabasePath,
      walPath,
      walQuarantinePath,
    },
    event,
    message,
    severity: 'WARN',
    terminalArgs: [
      `database_backup=${preservedDatabasePath ?? 'none'}`,
      `wal=${walQuarantinePath}`,
      `manifest=${manifestPath}`,
    ],
  })
}

const hasNonEmptyDuckdbWal = (databasePath: string) => {
  const walPath = `${databasePath}.wal`
  const walStat = statSync(walPath, {throwIfNoEntry: false})

  return walStat?.isFile() === true && walStat.size > 0
}

const getDuckdbStartupPreflightScript = () => {
  return `
    const databasePath = JSON.parse(process.argv[1])
    const options = JSON.parse(process.argv[2])
    const tableRepairSpecs = JSON.parse(process.argv[3])
    const activeRepairSpecPath = JSON.parse(process.argv[4])
    const {writeFileSync} = await import('node:fs')
    const {DuckDBInstance} = await import('@duckdb/node-api')

    let connection = null
    let instance = null

    const getRows = async (statement) => {
      const reader = await connection.runAndReadAll(statement)
      return reader.getRowObjectsJson()
    }

    const getSqlLiteral = (value) => {
      return "'" + String(value).replaceAll("'", "''") + "'"
    }

    const tableExists = async (schemaName, tableName) => {
      const rows = await getRows(
        "SELECT COUNT(*) AS tableCount FROM information_schema.tables " +
          "WHERE table_schema = " + getSqlLiteral(schemaName) +
          " AND table_name = " + getSqlLiteral(tableName),
      )
      return Number(rows[0]?.tableCount ?? 0) > 0
    }

    const getTableColumnNames = async (schemaName, tableName) => {
      const rows = await getRows(
        "SELECT column_name AS columnName FROM information_schema.columns " +
          "WHERE table_schema = " + getSqlLiteral(schemaName) +
          " AND table_name = " + getSqlLiteral(tableName),
      )
      return new Set(
        rows
          .map((row) => {
            return typeof row.columnName === 'string' ? row.columnName : null
          })
          .filter((columnName) => {
            return columnName !== null
          }),
      )
    }

    const getTableCreateSql = async (schemaName, tableName) => {
      const rows = await getRows(
        "SELECT sql FROM duckdb_tables() " +
          "WHERE schema_name = " + getSqlLiteral(schemaName) +
          " AND table_name = " + getSqlLiteral(tableName) +
          " LIMIT 1",
      )
      return typeof rows[0]?.sql === 'string' ? rows[0].sql : ''
    }

    const normalizeIndexColumnName = (columnName) => {
      return String(columnName).trim().replace(/^["']|["']$/g, '').toLowerCase()
    }

    const getIndexSqlColumns = (indexSql) => {
      const match = String(indexSql).match(/\\(([^()]*)\\)\\s*;?\\s*$/u)

      if (match === null) {
        return []
      }

      return match[1].split(',').map(normalizeIndexColumnName)
    }

    const hasUniqueIndexForColumns = async (spec) => {
      const expectedColumns = Array.isArray(spec.repairPrimaryKeyColumns)
        ? spec.repairPrimaryKeyColumns.map(normalizeIndexColumnName)
        : []

      if (expectedColumns.length === 0) {
        return true
      }

      const rows = await getRows(
        "SELECT sql FROM duckdb_indexes() " +
          "WHERE schema_name = " + getSqlLiteral(spec.schemaName) +
          " AND table_name = " + getSqlLiteral(spec.tableName),
      )

      return rows.some((row) => {
        if (typeof row.sql !== 'string' || !/^\\s*CREATE\\s+UNIQUE\\s+INDEX\\b/iu.test(row.sql)) {
          return false
        }

        const columns = getIndexSqlColumns(row.sql)

        return columns.length === expectedColumns.length && columns.every((column, index) => {
          return column === expectedColumns[index]
        })
      })
    }

    const needsInlinePrimaryKeyRepairBeforeMutation = async (spec) => {
      if (!Array.isArray(spec.repairPrimaryKeyColumns) || spec.repairPrimaryKeyColumns.length === 0) {
        return false
      }

      const createSql = await getTableCreateSql(spec.schemaName, spec.tableName)

      return createSql.toUpperCase().includes('PRIMARY KEY') || !(await hasUniqueIndexForColumns(spec))
    }

    const schemaRequirementsSatisfied = async (requirements) => {
      if (!Array.isArray(requirements) || requirements.length === 0) {
        return true
      }

      for (const requirement of requirements) {
        if (typeof requirement?.schemaName !== 'string' || typeof requirement?.tableName !== 'string') {
          return false
        }

        if (!(await tableExists(requirement.schemaName, requirement.tableName))) {
          return false
        }

        const columnNames = Array.isArray(requirement.columnNames) ? requirement.columnNames : []
        const actualColumnNames = await getTableColumnNames(requirement.schemaName, requirement.tableName)
        const missingColumnName = columnNames.find((columnName) => {
          return typeof columnName !== 'string' || !actualColumnNames.has(columnName)
        })

        if (missingColumnName !== undefined) {
          return false
        }
      }

      return true
    }

    const getPrimaryKeyColumns = async (schemaName, tableName) => {
      const rows = await getRows(
        "SELECT constraint_column_names AS primaryKeyColumns FROM duckdb_constraints() " +
          "WHERE schema_name = " + getSqlLiteral(schemaName) +
          " AND table_name = " + getSqlLiteral(tableName) +
          " AND constraint_type = 'PRIMARY KEY' " +
          "LIMIT 1",
      )
      return Array.isArray(rows[0]?.primaryKeyColumns) ? rows[0].primaryKeyColumns : []
    }

    const quoteIdentifier = (identifier) => {
      return '"' + String(identifier).replaceAll('"', '""') + '"'
    }

    const runDeleteInsertMutationProbe = async (schemaName, tableName) => {
      const primaryKeyColumns = await getPrimaryKeyColumns(schemaName, tableName)

      if (primaryKeyColumns.length === 0) {
        return
      }

      const probeTableName = 'startup_probe_delete_insert_' + schemaName + '_' + tableName
      const qualifiedName = schemaName + '.' + tableName

      await connection.run('DROP TABLE IF EXISTS ' + probeTableName)
      await connection.run('CREATE TEMP TABLE ' + probeTableName + ' AS SELECT * FROM ' + qualifiedName + ' LIMIT 1')

      const probeRows = await getRows('SELECT COUNT(*) AS rowCount FROM ' + probeTableName)
      if (Number(probeRows[0]?.rowCount ?? 0) === 0) {
        await connection.run('DROP TABLE IF EXISTS ' + probeTableName)
        return
      }

      const predicate = primaryKeyColumns
        .map((column) => {
          return (
            quoteIdentifier(column)
            + ' IS NOT DISTINCT FROM (SELECT '
            + quoteIdentifier(column)
            + ' FROM '
            + probeTableName
            + ' LIMIT 1)'
          )
        })
        .join(' AND ')

      await connection.run('BEGIN')
      await connection.run('DELETE FROM ' + qualifiedName + ' WHERE ' + predicate)
      await connection.run('INSERT INTO ' + qualifiedName + ' BY NAME SELECT * FROM ' + probeTableName)
      await connection.run('COMMIT')
      await connection.run('DROP TABLE IF EXISTS ' + probeTableName)
    }

    const markActiveRepairSpec = (spec, phase) => {
      if (typeof activeRepairSpecPath !== 'string' || activeRepairSpecPath.length === 0) {
        return
      }

      writeFileSync(
        activeRepairSpecPath,
        JSON.stringify({
          phase,
          schemaName: spec.schemaName,
          tableName: spec.tableName,
        }),
      )
    }

    const markActiveRepairSpecs = (specs, phase) => {
      if (typeof activeRepairSpecPath !== 'string' || activeRepairSpecPath.length === 0) {
        return
      }

      const repairSpecs = specs.map((spec) => {
        return {
          schemaName: spec.schemaName,
          tableName: spec.tableName,
        }
      })

      writeFileSync(
        activeRepairSpecPath,
        JSON.stringify({
          phase,
          repairSpecs,
          schemaName: repairSpecs[0]?.schemaName,
          tableName: repairSpecs[0]?.tableName,
        }),
      )
    }

    try {
      instance = await DuckDBInstance.create(databasePath, options)
      connection = await instance.connect()
      await connection.run('SELECT 1')

      const inlinePrimaryKeyRepairSpecs = []

      for (const spec of tableRepairSpecs) {
        if (await tableExists(spec.schemaName, spec.tableName) && await needsInlinePrimaryKeyRepairBeforeMutation(spec)) {
          inlinePrimaryKeyRepairSpecs.push(spec)
        }
      }

      if (inlinePrimaryKeyRepairSpecs.length > 0) {
        markActiveRepairSpecs(inlinePrimaryKeyRepairSpecs, 'inline-primary-key-repair')
        throw new Error('startup repair required before mutating inline primary key tables')
      }

      for (const spec of tableRepairSpecs) {
        if (await tableExists(spec.schemaName, spec.tableName)) {
          if (await schemaRequirementsSatisfied(spec.schemaRequirements)) {
            markActiveRepairSpec(spec, 'custom-mutation-probe')
            await connection.run(spec.mutationProbeSql)
          }
          markActiveRepairSpec(spec, 'generic-delete-insert-probe')
          await runDeleteInsertMutationProbe(spec.schemaName, spec.tableName)
        }
      }
    } finally {
      try {
        connection?.closeSync()
      } catch {}
      try {
        instance?.closeSync()
      } catch {}
    }
  `
}

const getDuckdbStartupPreflightActiveRepairSpecPath = (runtimeConfig: DuckdbRuntimeConfig) => {
  return join(`${runtimeConfig.databasePath}.startup-recovery`, 'startup-preflight-active-table.json')
}

const clearDuckdbStartupPreflightActiveRepairSpec = (markerPath: string) => {
  try {
    unlinkSync(markerPath)
  } catch {
    return
  }
}

const getDuckdbStartupPreflightRepairSpecs = (markerPath: string) => {
  try {
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as {
      repairSpecs?: unknown
      schemaName?: unknown
      tableName?: unknown
    }
    const markedRepairSpecs = Array.isArray(marker.repairSpecs) ? marker.repairSpecs : []
    const repairSpecs = markedRepairSpecs
      .map((repairSpec) => {
        if (
          repairSpec === null
          || typeof repairSpec !== 'object'
          || typeof (repairSpec as {schemaName?: unknown}).schemaName !== 'string'
          || typeof (repairSpec as {tableName?: unknown}).tableName !== 'string'
        ) {
          return null
        }

        const schemaName = (repairSpec as {schemaName: string}).schemaName
        const tableName = (repairSpec as {tableName: string}).tableName

        return (
          duckdbStartupIndexedTableRepairSpecs.find((candidate) => {
            return candidate.schemaName === schemaName && candidate.tableName === tableName
          }) ?? null
        )
      })
      .filter((repairSpec): repairSpec is DuckdbStartupIndexedTableRepairSpec => {
        return repairSpec !== null
      })

    if (repairSpecs.length > 0) {
      return repairSpecs
    }

    const schemaName = typeof marker.schemaName === 'string' ? marker.schemaName : null
    const tableName = typeof marker.tableName === 'string' ? marker.tableName : null

    if (schemaName === null || tableName === null) {
      return []
    }

    const spec = duckdbStartupIndexedTableRepairSpecs.find((candidate) => {
      return candidate.schemaName === schemaName && candidate.tableName === tableName
    })

    return spec === undefined ? [] : [spec]
  } catch {
    return []
  }
}

const shouldRunProactiveDuckdbStartupPreflight = (runtimeConfig: DuckdbRuntimeConfig) => {
  const memoryLimitMiB = parseDuckdbMemoryLimitToMiB(runtimeConfig.memoryLimit)

  return memoryLimitMiB === null || memoryLimitMiB >= duckdbProactiveStartupPreflightMinMemoryMiB
}

const getDuckdbStartupPreflightSpecsForRuntime = (
  runtimeConfig: DuckdbRuntimeConfig,
  activeRepairSpecs: DuckdbStartupIndexedTableRepairSpec[],
) => {
  if (activeRepairSpecs.length > 0) {
    return activeRepairSpecs
  }

  if (shouldRunProactiveDuckdbStartupPreflight(runtimeConfig)) {
    return duckdbStartupIndexedTableRepairSpecs
  }

  return duckdbStartupIndexedTableRepairSpecs.filter((spec) => {
    return spec.lowMemoryStartupPreflight === true
  })
}

const getDuckdbStartupIndexedTableRepairSpecs = (error: unknown): DuckdbStartupIndexedTableRepairSpec[] => {
  const candidateRepairSpecs = error instanceof Error ? (error as DuckdbStartupPreflightError).repairSpecs : null
  const repairSpecs = Array.isArray(candidateRepairSpecs) ? candidateRepairSpecs : []

  return repairSpecs.length === 0 ? duckdbStartupIndexedTableRepairSpecs : repairSpecs
}

const getDuckdbIndexedTableRepairScript = () => {
  return `
    const databasePath = JSON.parse(process.argv[1])
    const options = JSON.parse(process.argv[2])
    const tableRepairSpecs = JSON.parse(process.argv[3])
    const repairId = JSON.parse(process.argv[4])
    const {DuckDBInstance} = await import('@duckdb/node-api')

    let connection = null
    let instance = null

    const getRows = async (statement) => {
      const reader = await connection.runAndReadAll(statement)
      return reader.getRowObjectsJson()
    }

    const getSqlLiteral = (value) => {
      return "'" + String(value).replaceAll("'", "''") + "'"
    }

    const getQualifiedName = (schemaName, tableName) => {
      return schemaName + '.' + tableName
    }

    const regexpSpecialCharacters = new Set(['\\\\', '^', '$', '.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|'])

    const escapeRegExp = (value) => {
      return Array.from(String(value), (character) => {
        return regexpSpecialCharacters.has(character) ? '\\\\' + character : character
      }).join('')
    }

    const stripInlinePrimaryKeyConstraints = (createSql, primaryKeyColumns) => {
      if (!Array.isArray(primaryKeyColumns) || primaryKeyColumns.length === 0) {
        return createSql
      }

      const withoutInlinePrimaryKeys = primaryKeyColumns.reduce((sql, columnName) => {
        if (typeof columnName !== 'string' || columnName.trim().length === 0) {
          return sql
        }

        return sql.replace(
          new RegExp('(\\\\b' + escapeRegExp(columnName) + '\\\\b\\\\s+[^,)]*?)\\\\s+PRIMARY\\\\s+KEY', 'i'),
          '$1',
        )
      }, createSql)

      return withoutInlinePrimaryKeys
        .replace(/,\\s*(?:CONSTRAINT\\s+[^\\s]+\\s+)?PRIMARY\\s+KEY\\s*\\([^)]*\\)/i, '')
        .replace(/\\(\\s*(?:CONSTRAINT\\s+[^\\s]+\\s+)?PRIMARY\\s+KEY\\s*\\([^)]*\\)\\s*,/i, '(')
    }

    const getRepairPrimaryKeyIndexSql = (spec, sourceName) => {
      const primaryKeyColumns = Array.isArray(spec.repairPrimaryKeyColumns)
        ? spec.repairPrimaryKeyColumns.filter((columnName) => {
            return typeof columnName === 'string' && columnName.trim().length > 0
          })
        : []

      if (primaryKeyColumns.length === 0) {
        return null
      }

      return (
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_' + spec.tableName + '_repaired_pk_' + repairId + ' ON ' +
        sourceName +
        '(' +
        primaryKeyColumns.join(', ') +
        ')'
      )
    }

    const normalizeIndexColumnName = (columnName) => {
      return String(columnName).trim().replace(/^["']|["']$/g, '').toLowerCase()
    }

    const getIndexSqlColumns = (indexSql) => {
      const match = String(indexSql).match(/\\(([^()]*)\\)\\s*;?\\s*$/u)

      if (match === null) {
        return []
      }

      return match[1].split(',').map(normalizeIndexColumnName)
    }

    const hasUniqueIndexForPrimaryKeyColumns = async (spec) => {
      const expectedColumns = Array.isArray(spec.repairPrimaryKeyColumns)
        ? spec.repairPrimaryKeyColumns.map(normalizeIndexColumnName)
        : []

      if (expectedColumns.length === 0) {
        return true
      }

      const rows = await getRows(
        "SELECT sql FROM duckdb_indexes() " +
          "WHERE schema_name = " + getSqlLiteral(spec.schemaName) +
          " AND table_name = " + getSqlLiteral(spec.tableName),
      )

      return rows.some((row) => {
        if (typeof row.sql !== 'string' || !/^\\s*CREATE\\s+UNIQUE\\s+INDEX\\b/iu.test(row.sql)) {
          return false
        }

        const columns = getIndexSqlColumns(row.sql)

        return columns.length === expectedColumns.length && columns.every((column, index) => {
          return column === expectedColumns[index]
        })
      })
    }

    const assertRepairPostconditions = async (spec) => {
      const tableRows = await getRows(
        "SELECT sql FROM duckdb_tables() " +
          "WHERE schema_name = " + getSqlLiteral(spec.schemaName) +
          " AND table_name = " + getSqlLiteral(spec.tableName) +
          " LIMIT 1",
      )
      const createSql = String(tableRows[0]?.sql ?? '')

      const primaryKeyColumns = Array.isArray(spec.repairPrimaryKeyColumns) ? spec.repairPrimaryKeyColumns : []

      if (primaryKeyColumns.length > 0) {
        if (/\\bPRIMARY\\s+KEY\\b/iu.test(createSql)) {
          throw new Error('repaired table DDL still contains PRIMARY KEY for ' + getQualifiedName(spec.schemaName, spec.tableName))
        }

        if (!(await hasUniqueIndexForPrimaryKeyColumns(spec))) {
          throw new Error('repaired table is missing replacement unique index for ' + getQualifiedName(spec.schemaName, spec.tableName))
        }
      }
    }

    const tableExists = async (schemaName, tableName) => {
      const rows = await getRows(
        "SELECT COUNT(*) AS tableCount FROM information_schema.tables " +
          "WHERE table_schema = " + getSqlLiteral(schemaName) +
          " AND table_name = " + getSqlLiteral(tableName),
      )
      return Number(rows[0]?.tableCount ?? 0) > 0
    }

    const getTableColumnNames = async (schemaName, tableName) => {
      const rows = await getRows(
        "SELECT column_name AS columnName FROM information_schema.columns " +
          "WHERE table_schema = " + getSqlLiteral(schemaName) +
          " AND table_name = " + getSqlLiteral(tableName),
      )
      return new Set(
        rows
          .map((row) => {
            return typeof row.columnName === 'string' ? row.columnName : null
          })
          .filter((columnName) => {
            return columnName !== null
          }),
      )
    }

    const schemaRequirementsSatisfied = async (requirements) => {
      if (!Array.isArray(requirements) || requirements.length === 0) {
        return true
      }

      for (const requirement of requirements) {
        if (typeof requirement?.schemaName !== 'string' || typeof requirement?.tableName !== 'string') {
          return false
        }

        if (!(await tableExists(requirement.schemaName, requirement.tableName))) {
          return false
        }

        const columnNames = Array.isArray(requirement.columnNames) ? requirement.columnNames : []
        const actualColumnNames = await getTableColumnNames(requirement.schemaName, requirement.tableName)
        const missingColumnName = columnNames.find((columnName) => {
          return typeof columnName !== 'string' || !actualColumnNames.has(columnName)
        })

        if (missingColumnName !== undefined) {
          return false
        }
      }

      return true
    }

    try {
      instance = await DuckDBInstance.create(databasePath, options)
      connection = await instance.connect()

      for (const spec of tableRepairSpecs) {
        if (!(await tableExists(spec.schemaName, spec.tableName))) {
          continue
        }

        const duplicateRows = await getRows(spec.duplicateKeySelectSql)
        const duplicateCount = Number(duplicateRows[0]?.duplicateCount ?? 0)

        if (duplicateCount > 0) {
          throw new Error(
            'cannot rebuild ' + getQualifiedName(spec.schemaName, spec.tableName)
              + ' because table data contains ' + duplicateCount + ' duplicate primary keys',
          )
        }

        const tableRows = await getRows(
          "SELECT sql FROM duckdb_tables() " +
            "WHERE schema_name = " + getSqlLiteral(spec.schemaName) +
            " AND table_name = " + getSqlLiteral(spec.tableName) +
            " LIMIT 1",
        )
        const createSql = tableRows[0]?.sql

        if (typeof createSql !== 'string' || createSql.length === 0) {
          throw new Error('missing table DDL for ' + getQualifiedName(spec.schemaName, spec.tableName))
        }

        const indexRows = await getRows(
          "SELECT index_name AS indexName, sql FROM duckdb_indexes() " +
            "WHERE schema_name = " + getSqlLiteral(spec.schemaName) +
            " AND table_name = " + getSqlLiteral(spec.tableName) +
            " AND sql IS NOT NULL " +
            "ORDER BY index_name",
        )
        const repairTableName = spec.tableName + '_startup_repair_' + repairId
        const sourceName = getQualifiedName(spec.schemaName, spec.tableName)
        const repairName = getQualifiedName(spec.schemaName, repairTableName)
	        let createRepairSql = createSql.replace(
	          'CREATE TABLE ' + sourceName + '(',
	          'CREATE TABLE ' + repairName + '(',
	        )
	        createRepairSql = stripInlinePrimaryKeyConstraints(createRepairSql, spec.repairPrimaryKeyColumns)

        if (createRepairSql === createSql) {
          throw new Error('could not rewrite table DDL for ' + sourceName)
        }

        await connection.run('DROP TABLE IF EXISTS ' + repairName)
        await connection.run(createRepairSql)
        if (spec.repairStrategy !== 'empty-derived') {
          await connection.run('INSERT INTO ' + repairName + ' BY NAME SELECT * FROM ' + sourceName)
        }
	        await connection.run('DROP TABLE ' + sourceName)
	        await connection.run('ALTER TABLE ' + repairName + ' RENAME TO ' + spec.tableName)
	        await connection.run(
	          'DROP INDEX IF EXISTS ' + spec.schemaName + '.idx_' + spec.tableName + '_repaired_pk',
	        )
	        const repairPrimaryKeyIndexSql = getRepairPrimaryKeyIndexSql(spec, sourceName)

	        if (repairPrimaryKeyIndexSql !== null) {
	          await connection.run(repairPrimaryKeyIndexSql)
	        }

	        for (const indexRow of indexRows) {
          if (String(indexRow.indexName).startsWith('idx_' + spec.tableName + '_repaired_pk')) {
            continue
          }

          const indexSql = String(indexRow.sql)
            .replace(/^CREATE UNIQUE INDEX /, 'CREATE UNIQUE INDEX IF NOT EXISTS ')
            .replace(/^CREATE INDEX /, 'CREATE INDEX IF NOT EXISTS ')
          await connection.run(indexSql)
        }

        if (
          typeof spec.postRepairSql === 'string'
          && spec.postRepairSql.trim().length > 0
          && (await schemaRequirementsSatisfied(spec.postRepairSchemaRequirements))
        ) {
          await connection.run(spec.postRepairSql)
        }

        await assertRepairPostconditions(spec)
      }

    } finally {
      try {
        connection?.closeSync()
      } catch {}
      try {
        instance?.closeSync()
      } catch {}
    }
  `
}

const getDuckdbStartupPreflightError = (
  runtimeConfig: DuckdbRuntimeConfig,
  hadWalBeforePreflight: boolean,
  pendingPostRepairPreflightSpecs: DuckdbStartupIndexedTableRepairSpec[] = [],
) => {
  if (
    runtimeConfig.databasePath === ':memory:'
    || process.env.FORSKA_DUCKDB_STARTUP_WAL_PREFLIGHT === duckdbStartupWalPreflightDisabledEnvValue
  ) {
    return null
  }

  if (!statSync(runtimeConfig.databasePath, {throwIfNoEntry: false})?.isFile()) {
    return null
  }

  const activeRepairSpecPath = getDuckdbStartupPreflightActiveRepairSpecPath(runtimeConfig)
  mkdirSync(`${runtimeConfig.databasePath}.startup-recovery`, {recursive: true})
  const activeRepairSpecs = getDuckdbStartupPreflightRepairSpecs(activeRepairSpecPath)

  if (activeRepairSpecs.length > 0) {
    const error = new Error(
      `DuckDB startup indexed-table repair marker requested repair for ${runtimeConfig.databasePath}`,
    ) as DuckdbStartupPreflightError
    error.repairMarkerOnly = true
    error.repairMarkerPath = activeRepairSpecPath
    error.repairSpecs = activeRepairSpecs
    return error
  }

  const targetedPreflightSpecs = activeRepairSpecs.length > 0 ? activeRepairSpecs : pendingPostRepairPreflightSpecs
  const preflightRepairSpecs = hadWalBeforePreflight
    ? []
    : getDuckdbStartupPreflightSpecsForRuntime(runtimeConfig, targetedPreflightSpecs)

  if (preflightRepairSpecs.length === 0 && !hadWalBeforePreflight) {
    writeRuntimeOperatorLogEvent({
      attrs: {
        databasePath: runtimeConfig.databasePath,
        memoryLimit: runtimeConfig.memoryLimit,
        minimumMemoryMiB: duckdbProactiveStartupPreflightMinMemoryMiB,
      },
      event: 'duckdb.startup.preflight-skip-low-memory',
      message: '[duckdb] skipped proactive startup mutation preflight under low-memory runtime',
      severity: 'INFO',
    })
    return null
  }

  clearDuckdbStartupPreflightActiveRepairSpec(activeRepairSpecPath)

  const result = globalThis.Bun.spawnSync(
    [
      process.execPath,
      '-e',
      getDuckdbStartupPreflightScript(),
      JSON.stringify(runtimeConfig.databasePath),
      JSON.stringify(getDuckdbInstanceOptions(runtimeConfig)),
      JSON.stringify(preflightRepairSpecs),
      JSON.stringify(activeRepairSpecPath),
    ],
    {
      cwd: process.cwd(),
      env: {...process.env, FORSKA_DUCKDB_STARTUP_WAL_PREFLIGHT_CHILD: 'true'},
      stderr: 'pipe',
      stdin: 'ignore',
      stdout: 'pipe',
    },
  )

  if (result.exitCode === 0) {
    clearDuckdbStartupPreflightActiveRepairSpec(activeRepairSpecPath)
    return null
  }

  const stderr = result.stderr.toString().trim()
  const stdout = result.stdout.toString().trim()
  const signalText = result.signalCode === null ? null : `signal=${result.signalCode}`
  const outputText = [stderr, stdout, signalText]
    .filter((value) => {
      return value !== null && value !== ''
    })
    .join(' -- ')
  const failureText = outputText === '' ? `exitCode=${result.exitCode ?? 'unknown'}` : outputText

  const error = new Error(
    `DuckDB startup preflight failed for ${runtimeConfig.databasePath}: ${failureText}`,
  ) as DuckdbStartupPreflightError
  const repairSpecs = getDuckdbStartupPreflightRepairSpecs(activeRepairSpecPath)

  if (repairSpecs.length > 0) {
    error.repairMarkerPath = activeRepairSpecPath
    error.repairSpecs = repairSpecs
  }

  return error
}

const getDuckdbStartupFileLockProbeScript = () => {
  return `
    const databasePath = JSON.parse(process.argv[1])
    const options = JSON.parse(process.argv[2])
    const {DuckDBInstance} = await import('@duckdb/node-api')

    const instance = await DuckDBInstance.create(databasePath, options)
    instance.closeSync()
  `
}

const getDuckdbStartupWalCheckpointScript = () => {
  return `
    const databasePath = JSON.parse(process.argv[1])
    const options = JSON.parse(process.argv[2])
    const {DuckDBInstance} = await import('@duckdb/node-api')

    let connection = null
    let instance = null

    try {
      instance = await DuckDBInstance.create(databasePath, options)
      connection = await instance.connect()
      await connection.run('CHECKPOINT')
    } finally {
      try {
        connection?.closeSync()
      } catch {}
      try {
        instance?.closeSync()
      } catch {}
    }
  `
}

const getDuckdbStartupChildOutputText = (result: ReturnType<typeof globalThis.Bun.spawnSync>) => {
  const stderr = result.stderr.toString().trim()
  const stdout = result.stdout.toString().trim()
  const signalText = result.signalCode === null ? null : `signal=${result.signalCode}`

  return [stderr, stdout, signalText]
    .filter((value) => {
      return value !== null && value !== ''
    })
    .join(' -- ')
}

const waitForDuckdbStartupRepairFileLock = async (runtimeConfig: DuckdbRuntimeConfig) => {
  let result: ReturnType<typeof globalThis.Bun.spawnSync> | null = null
  let outputText = ''

  for (let attempt = 0; attempt <= duckdbStartupIndexedTableRepairLockRetryDelaysMs.length; attempt += 1) {
    result = globalThis.Bun.spawnSync(
      [
        process.execPath,
        '-e',
        getDuckdbStartupFileLockProbeScript(),
        JSON.stringify(runtimeConfig.databasePath),
        JSON.stringify(getDuckdbIndexedTableRepairInstanceOptions(runtimeConfig)),
      ],
      {
        cwd: process.cwd(),
        env: {...process.env, FORSKA_DUCKDB_STARTUP_LOCK_PROBE_CHILD: 'true'},
        stderr: 'pipe',
        stdin: 'ignore',
        stdout: 'pipe',
      },
    )
    outputText = getDuckdbStartupChildOutputText(result)

    if (result.exitCode === 0) {
      return
    }

    const retryDelayMs = duckdbStartupIndexedTableRepairLockRetryDelaysMs[attempt]

    if (retryDelayMs === undefined || !isDuckdbTransientFileLockError(outputText)) {
      break
    }

    writeRuntimeOperatorLogEvent({
      attrs: {attempt: attempt + 1, databasePath: runtimeConfig.databasePath, error: outputText, retryDelayMs},
      event: 'duckdb.startup.repair-lock-probe-retry',
      message: '[duckdb] retrying startup repair after transient DuckDB file lock',
      severity: 'WARN',
      terminalArgs: [`attempt=${attempt + 1}`, `retry_ms=${retryDelayMs}`],
    })
    await sleepMs(retryDelayMs)
  }

  throw new Error(
    `DuckDB startup repair lock probe failed for ${runtimeConfig.databasePath}: ${
      outputText === '' ? `exitCode=${result?.exitCode ?? 'unknown'}` : outputText
    }`,
  )
}

const checkpointDuckdbStartupWalReplay = async (runtimeConfig: DuckdbRuntimeConfig) => {
  const result = globalThis.Bun.spawnSync(
    [
      process.execPath,
      '-e',
      getDuckdbStartupWalCheckpointScript(),
      JSON.stringify(runtimeConfig.databasePath),
      JSON.stringify(getDuckdbInstanceOptions(runtimeConfig)),
    ],
    {
      cwd: process.cwd(),
      env: {...process.env, FORSKA_DUCKDB_STARTUP_WAL_CHECKPOINT_CHILD: 'true'},
      stderr: 'pipe',
      stdin: 'ignore',
      stdout: 'pipe',
    },
  )

  if (result.exitCode === 0) {
    writeRuntimeOperatorLogEvent({
      attrs: {databasePath: runtimeConfig.databasePath},
      event: 'duckdb.startup.wal-checkpoint',
      message: '[duckdb] checkpointed replayed WAL before startup mutation preflight',
      severity: 'INFO',
    })
    return
  }

  const outputText = getDuckdbStartupChildOutputText(result)

  throw new Error(
    `DuckDB startup WAL checkpoint failed for ${runtimeConfig.databasePath}: ${
      outputText === '' ? `exitCode=${result.exitCode ?? 'unknown'}` : outputText
    }`,
  )
}

const repairDuckdbStartupIndexedTables = async (runtimeConfig: DuckdbRuntimeConfig, error: unknown) => {
  if (runtimeConfig.databasePath === ':memory:') {
    throw new Error('DuckDB indexed-table repair is unavailable for :memory: databases')
  }

  const recoveryPathPart = getDuckdbRecoveryPathPart()
  const repairId = recoveryPathPart.replace(/[^a-zA-Z0-9_]/g, '_')
  const recoveryDirectory = `${runtimeConfig.databasePath}.startup-recovery`
  const databaseBackupPath = join(recoveryDirectory, `${recoveryPathPart}.pre-repair.duckdb`)
  const manifestPath = join(recoveryDirectory, `${recoveryPathPart}.recovery.json`)
  const repairSpecs = getDuckdbStartupIndexedTableRepairSpecs(error)

  await mkdir(recoveryDirectory, {recursive: true})
  await waitForDuckdbStartupRepairFileLock(runtimeConfig)
  let preservedDatabasePath = await copyDuckdbDatabaseBeforeWalRecovery({
    databaseBackupPath,
    databasePath: runtimeConfig.databasePath,
  })

  let result: ReturnType<typeof globalThis.Bun.spawnSync> | null = null
  let outputText = ''

  for (let attempt = 0; attempt <= duckdbStartupIndexedTableRepairLockRetryDelaysMs.length; attempt += 1) {
    result = globalThis.Bun.spawnSync(
      [
        process.execPath,
        '-e',
        getDuckdbIndexedTableRepairScript(),
        JSON.stringify(runtimeConfig.databasePath),
        JSON.stringify(getDuckdbIndexedTableRepairInstanceOptions(runtimeConfig)),
        JSON.stringify(repairSpecs),
        JSON.stringify(repairId),
      ],
      {
        cwd: process.cwd(),
        env: {...process.env, FORSKA_DUCKDB_STARTUP_INDEX_REPAIR_CHILD: 'true'},
        stderr: 'pipe',
        stdin: 'ignore',
        stdout: 'pipe',
      },
    )

    outputText = getDuckdbStartupChildOutputText(result)

    if (result.exitCode === 0) {
      break
    }

    const retryDelayMs = duckdbStartupIndexedTableRepairLockRetryDelaysMs[attempt]

    if (retryDelayMs === undefined || !isDuckdbTransientFileLockError(outputText)) {
      break
    }

    writeRuntimeOperatorLogEvent({
      attrs: {attempt: attempt + 1, databasePath: runtimeConfig.databasePath, error: outputText, retryDelayMs},
      event: 'duckdb.startup.indexed-table-repair-lock-retry',
      message: '[duckdb] retrying startup indexed-table repair after transient DuckDB file lock',
      severity: 'WARN',
      terminalArgs: [`attempt=${attempt + 1}`, `retry_ms=${retryDelayMs}`],
    })
    await sleepMs(retryDelayMs)
    await waitForDuckdbStartupRepairFileLock(runtimeConfig)
    preservedDatabasePath = await copyDuckdbDatabaseBeforeWalRecovery({
      databaseBackupPath,
      databasePath: runtimeConfig.databasePath,
    })
  }

  if (result === null || result.exitCode !== 0) {
    throw new Error(
      `DuckDB startup indexed-table repair failed for ${runtimeConfig.databasePath}: ${
        outputText === '' ? `exitCode=${result?.exitCode ?? 'unknown'}` : outputText
      }`,
    )
  }

  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        checkpointSourcePath: runtimeConfig.databasePath,
        error: getCompactDuckdbErrorMessage(error),
        preservedDatabasePath,
        recoveredAt: new Date().toISOString(),
        recovery: 'indexed-table-rebuild',
        repairStrategies: Object.fromEntries(
          repairSpecs.map((spec) => {
            return [`${spec.schemaName}.${spec.tableName}`, spec.repairStrategy ?? 'copy']
          }),
        ),
        repairedTables: repairSpecs.map((spec) => {
          return `${spec.schemaName}.${spec.tableName}`
        }),
      },
      null,
      2,
    ),
  )
  writeRuntimeFailureLogEvent({
    attrs: {
      databasePath: runtimeConfig.databasePath,
      error,
      manifestPath,
      preservedDatabasePath,
      repairedTables: repairSpecs.map((spec) => {
        return `${spec.schemaName}.${spec.tableName}`
      }),
    },
    event: 'duckdb.startup.indexed-table-repair',
    message: '[duckdb] rebuilt indexed tables after startup mutation preflight failure',
    severity: 'WARN',
    terminalArgs: [`database_backup=${preservedDatabasePath ?? 'none'}`, `manifest=${manifestPath}`],
  })
}

const runDuckdbStartupWalPreflight = async (runtimeConfig: DuckdbRuntimeConfig) => {
  let attemptedIndexedTableRepair = false
  let checkpointedWalReplay = false
  let lockRetryCount = 0
  let pendingPostRepairPreflightSpecs: DuckdbStartupIndexedTableRepairSpec[] = []

  for (let recoveryAttempt = 0; recoveryAttempt < 3; ) {
    const hadWalBeforePreflight = hasNonEmptyDuckdbWal(runtimeConfig.databasePath)
    const error = getDuckdbStartupPreflightError(runtimeConfig, hadWalBeforePreflight, pendingPostRepairPreflightSpecs)

    if (error === null) {
      if (!hadWalBeforePreflight) {
        pendingPostRepairPreflightSpecs = []
      }

      if (hadWalBeforePreflight && !checkpointedWalReplay) {
        checkpointedWalReplay = true
        try {
          await checkpointDuckdbStartupWalReplay(runtimeConfig)
        } catch (checkpointError) {
          if (hasNonEmptyDuckdbWal(runtimeConfig.databasePath)) {
            await quarantineFailedDuckdbWalReplay(runtimeConfig, checkpointError, {
              event: 'duckdb.startup.wal-checkpoint-quarantine',
              message: '[duckdb] quarantined WAL after startup checkpoint failure',
              recovery: 'wal-checkpoint-quarantine-retry-from-last-checkpoint',
              walFileSuffix: 'failed-checkpoint',
            })
            continue
          }

          throw checkpointError
        }
        continue
      }

      return
    }

    const errorMessage = getNormalizedDuckdbError(error).message
    const compactErrorMessage = getCompactDuckdbErrorMessage(error)
    const retryDelayMs = duckdbStartupPreflightLockRetryDelaysMs[lockRetryCount]

    if (isDuckdbTransientFileLockError(errorMessage)) {
      if (retryDelayMs === undefined) {
        throw error
      }

      writeRuntimeOperatorLogEvent({
        attrs: {
          databasePath: runtimeConfig.databasePath,
          error: compactErrorMessage,
          retryAttempt: lockRetryCount + 1,
          retryDelayMs,
        },
        event: 'duckdb.startup.preflight-lock-retry',
        message: '[duckdb] retrying startup preflight after transient DuckDB file lock',
        severity: 'WARN',
        terminalArgs: [`attempt=${lockRetryCount + 1}`, `retry_ms=${retryDelayMs}`],
      })
      lockRetryCount += 1
      await sleepMs(retryDelayMs)
      continue
    }

    lockRetryCount = 0
    recoveryAttempt += 1

    const markerOnlyRepair = error instanceof Error && error.repairMarkerOnly === true

    if (!markerOnlyRepair && hadWalBeforePreflight && hasNonEmptyDuckdbWal(runtimeConfig.databasePath)) {
      await quarantineFailedDuckdbWalReplay(runtimeConfig, error)
      continue
    }

    if (!hadWalBeforePreflight && hasNonEmptyDuckdbWal(runtimeConfig.databasePath)) {
      await quarantineFailedDuckdbWalReplay(runtimeConfig, error, {
        event: 'duckdb.startup.preflight-mutation-wal-quarantine',
        message: '[duckdb] quarantined WAL left by failed startup mutation preflight',
        recovery: 'startup-preflight-mutation-wal-quarantine',
        walFileSuffix: 'failed-startup-probe',
      })
    }

    if (!attemptedIndexedTableRepair) {
      attemptedIndexedTableRepair = true
      const repairSpecs = getDuckdbStartupIndexedTableRepairSpecs(error)
      await repairDuckdbStartupIndexedTables(runtimeConfig, error)
      const repairMarkerPath = error instanceof Error ? error.repairMarkerPath : undefined

      if (typeof repairMarkerPath === 'string') {
        clearDuckdbStartupPreflightActiveRepairSpec(repairMarkerPath)
      }
      pendingPostRepairPreflightSpecs = repairSpecs
      continue
    }

    throw error
  }

  throw new Error(`DuckDB startup preflight did not recover ${runtimeConfig.databasePath}`)
}

const withNormalizedDuckdbError = async <T>(work: () => Promise<T>, canRetryAfterRestart = true): Promise<T> => {
  try {
    return await work()
  } catch (error) {
    const normalizedError = getNormalizedDuckdbError(error)

    if (duckdbShutdownInProgress && isDuckdbRestartRequiredError(normalizedError)) {
      throw normalizedError
    }

    if (!canRetryAfterRestart || !isDuckdbRestartRequiredError(normalizedError)) {
      throw normalizedError
    }

    await recoverDuckdbRuntimeAfterFatalError(normalizedError)

    try {
      return await work()
    } catch (retryError) {
      throw getChainedDuckdbError(normalizedError, retryError, 'restart retry failed')
    }
  }
}

const resetDuckdbRuntimeState = () => {
  const appendLaneCount = getDuckdbRuntimeConfigValue().appendLaneCount

  duckdbServiceState.appendBarrier = null
  duckdbServiceState.appendConnections = []
  duckdbServiceState.appendLastDurationMs = null
  duckdbServiceState.appendMaxQueueDepthByLane = getInitialDuckdbAppendLaneMetrics(appendLaneCount)
  duckdbServiceState.appendPendingCountByLane = getInitialDuckdbAppendLaneMetrics(appendLaneCount)
  duckdbServiceState.appendQueues = getInitialDuckdbAppendQueues(appendLaneCount)
  duckdbServiceState.appendTotalBatchesCompleted = 0
  duckdbServiceState.appendTotalBatchesStarted = 0
  duckdbServiceState.appendTotalDurationMs = 0
  duckdbServiceState.backgroundConnection = null
  duckdbServiceState.backgroundLastDurationMs = null
  duckdbServiceState.backgroundLastWaitMs = null
  duckdbServiceState.backgroundMaxQueueDepth = 0
  duckdbServiceState.backgroundPendingCount = 0
  duckdbServiceState.backgroundQueue = Promise.resolve()
  duckdbServiceState.backgroundTasksCompleted = 0
  duckdbServiceState.backgroundTasksStarted = 0
  duckdbServiceState.backgroundTotalDurationMs = 0
  duckdbServiceState.backgroundTotalWaitMs = 0
  duckdbServiceState.controlConnection = null
  duckdbServiceState.controlTransactionDepth = 0
  duckdbServiceState.duckdbInstance = null
  duckdbServiceState.duckdbLastDurationMs = null
  duckdbServiceState.duckdbLastWaitMs = null
  duckdbServiceState.duckdbMaxQueueDepth = 0
  duckdbServiceState.duckdbPendingCount = 0
  duckdbServiceState.duckdbQueue = Promise.resolve()
  duckdbServiceState.duckdbRuntimeConfig = null
  duckdbServiceState.duckdbTasksCompleted = 0
  duckdbServiceState.duckdbTasksStarted = 0
  duckdbServiceState.duckdbTotalDurationMs = 0
  duckdbServiceState.duckdbTotalWaitMs = 0
  duckdbServiceState.duckdbWorkloadMetrics = []
  duckdbServiceState.nextAppendLaneIndex = 0
  duckdbServiceState.startupPromise = null
}

const getDuckdbConnection = () => {
  if (duckdbServiceState.controlConnection === null) {
    throw new Error('DuckDB connection not started')
  }

  return duckdbServiceState.controlConnection
}

const getDuckdbAppendConnection = (laneIndex: number) => {
  const appendConnection = duckdbServiceState.appendConnections[laneIndex]

  if (appendConnection === undefined) {
    throw new Error(`DuckDB append lane ${laneIndex} not started`)
  }

  return appendConnection
}

const getDuckdbBackgroundConnection = () => {
  if (duckdbServiceState.backgroundConnection === null) {
    throw new Error('DuckDB background connection not started')
  }

  return duckdbServiceState.backgroundConnection
}

const createDuckdbAppendBarrier = (previous: DuckdbAppendBarrier | null): DuckdbAppendBarrier => {
  let resolve: DuckdbAppendBarrier['resolve'] = () => {
    return undefined
  }
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve
  })

  return {active: true, previous, promise, resolve}
}

const waitForDuckdbAppendBarrier = async (): Promise<void> => {
  const currentBarrier = duckdbServiceState.appendBarrier

  return currentBarrier === null || !currentBarrier.active
    ? undefined
    : currentBarrier.promise.then(() => {
        return waitForDuckdbAppendBarrier()
      })
}

const getDuckdbAppendQueueSnapshot = () => {
  return [...duckdbServiceState.appendQueues]
}

const waitForDuckdbAppendQueues = async (): Promise<void> => {
  await Promise.all(getDuckdbAppendQueueSnapshot())
}

const waitForDuckdbBackgroundQueue = async (): Promise<void> => {
  await duckdbServiceState.backgroundQueue
}

const getActiveDuckdbAppendBarrier = (barrier: DuckdbAppendBarrier | null): DuckdbAppendBarrier | null => {
  return barrier === null || barrier.active ? barrier : getActiveDuckdbAppendBarrier(barrier.previous)
}

const withDuckdbAppendBarrier = async <T>(work: () => Promise<T>): Promise<T> => {
  const previousAppendBarrier = duckdbServiceState.appendBarrier
  const appendBarrier = createDuckdbAppendBarrier(previousAppendBarrier)
  duckdbServiceState.appendBarrier = appendBarrier

  try {
    await waitForDuckdbAppendQueues()
    await waitForDuckdbBackgroundQueue()
    return await work()
  } finally {
    appendBarrier.active = false
    duckdbServiceState.appendBarrier =
      duckdbServiceState.appendBarrier === appendBarrier
        ? getActiveDuckdbAppendBarrier(previousAppendBarrier)
        : getActiveDuckdbAppendBarrier(duckdbServiceState.appendBarrier)
    appendBarrier.resolve()
  }
}

const getCloseSyncError = (close: (() => void) | null) => {
  if (close === null) {
    return null
  }

  try {
    close()
    return null
  } catch (error) {
    return getNormalizedDuckdbError(error)
  }
}

const getCombinedCloseError = (errors: Array<Error | null>): Error | null => {
  const [firstError, secondError, ...remainingErrors] = errors.filter((error): error is Error => {
    return error !== null
  })

  return firstError === undefined
    ? null
    : secondError === undefined
      ? firstError
      : getCombinedCloseError([getChainedDuckdbError(firstError, secondError, 'close failed'), ...remainingErrors])
}

const getAppendConnectionCloseErrors = (appendConnections: DuckDBConnection[]): Array<Error | null> => {
  return appendConnections.map((appendConnection) => {
    return getCloseSyncError(() => {
      appendConnection.interrupt()
      appendConnection.closeSync()
    })
  })
}

const getDuckdbActiveQueueDepth = () => {
  return duckdbServiceState.duckdbPendingCount + duckdbServiceState.backgroundPendingCount + getDuckdbAppendQueueDepth()
}

const checkpointDuckdbBeforeClose = async (connection: DuckDBConnection | null, hasOpenTransaction: boolean) => {
  if (connection === null || hasOpenTransaction || (duckdbShutdownInProgress && getDuckdbActiveQueueDepth() > 0)) {
    return
  }

  if (shouldSerializeDuckdbConcurrentWork(getDuckdbRuntimeConfigValue().memoryLimit)) {
    return
  }

  try {
    await connection.run('CHECKPOINT')
  } catch (error) {
    writeRuntimeFailureLogEvent({
      attrs: {error},
      event: 'duckdb.shutdown.checkpoint-failure',
      message: '[duckdb] failed to checkpoint before shutdown',
      severity: 'WARN',
      terminalArgs: [getCompactDuckdbErrorMessage(error)],
    })
  }
}

const closeDuckdbServiceWithoutBarrier = async ({
  closeRuntime = true,
  checkpointBeforeClose = true,
  releaseOwnerLease = true,
}: CloseDuckdbServiceOptions = {}) => {
  const activeConnection = duckdbServiceState.controlConnection
  const activeAppendConnections = [...duckdbServiceState.appendConnections]
  const activeBackgroundConnection = duckdbServiceState.backgroundConnection
  const hasOpenControlTransaction = duckdbServiceState.controlTransactionDepth > 0
  const activeInstance = duckdbServiceState.duckdbInstance

  if (checkpointBeforeClose) {
    await checkpointDuckdbBeforeClose(activeConnection, hasOpenControlTransaction)
  }

  resetDuckdbRuntimeState()

  if (!closeRuntime) {
    if (releaseOwnerLease) {
      await releaseCurrentDuckdbOwnerLease()
    }

    return
  }

  const closeError = getCombinedCloseError([
    getCloseSyncError(
      activeConnection === null
        ? null
        : () => {
            activeConnection.interrupt()
            activeConnection.closeSync()
          },
    ),
    ...getAppendConnectionCloseErrors(activeAppendConnections),
    getCloseSyncError(
      activeBackgroundConnection === null
        ? null
        : () => {
            activeBackgroundConnection.interrupt()
            activeBackgroundConnection.closeSync()
          },
    ),
    getCloseSyncError(
      activeInstance === null
        ? null
        : () => {
            activeInstance.closeSync()
          },
    ),
  ])

  if (releaseOwnerLease) {
    try {
      await releaseCurrentDuckdbOwnerLease()
    } catch (error) {
      throw closeError === null ? error : getChainedDuckdbError(closeError, error, 'lease release failed')
    }
  }

  if (closeError !== null) {
    throw closeError
  }
}

const closeDuckdbServiceDirect = async (options: CloseDuckdbServiceOptions = {}) => {
  return withDuckdbAppendBarrier(async () => {
    await duckdbServiceState.duckdbQueue
    return closeDuckdbServiceWithoutBarrier(options)
  })
}

const closeDuckdbServiceForSignal = async () => {
  duckdbShutdownInProgress = true
  const shouldCloseRuntime = !shouldSerializeDuckdbConcurrentWork(getDuckdbRuntimeConfigValue().memoryLimit)

  return closeDuckdbServiceWithoutBarrier({
    checkpointBeforeClose: shouldCloseRuntime,
    closeRuntime: shouldCloseRuntime,
    releaseOwnerLease: shouldCloseRuntime,
  })
}

const registerDuckdbShutdownHooks = () => {
  if (duckdbServiceState.shutdownHooksRegistered) {
    return
  }

  duckdbServiceState.shutdownHooksRegistered = true
  ;(['SIGINT', 'SIGTERM'] as const).map((signal) => {
    process.once(signal, () => {
      void closeDuckdbServiceForSignal().then(
        () => {
          void exitWithRuntimeLogFlush({code: 0})
        },
        (error) => {
          writeRuntimeFailureLogEvent({
            attrs: {error, signal},
            event: 'duckdb.shutdown.failure',
            message: `[duckdb] shutdown failed on ${signal}`,
            terminalArgs: [error],
          })
          void exitWithRuntimeLogFlush({code: 1})
        },
      )
    })
  })
}

const createDuckdbInstance = async (runtimeConfig: DuckdbRuntimeConfig) => {
  return DuckDBInstance.create(runtimeConfig.databasePath, getDuckdbInstanceOptions(runtimeConfig))
}

const cleanupFailedDuckdbStart = async (params: {
  appendConnections: DuckDBConnection[]
  backgroundConnection: DuckDBConnection | null
  controlConnection: DuckDBConnection | null
  duckdbInstance: DuckDBInstance | null
}) => {
  const closeError = getCombinedCloseError([
    getCloseSyncError(
      params.controlConnection === null
        ? null
        : () => {
            const controlConnection = params.controlConnection

            if (controlConnection === null) {
              return
            }

            controlConnection.closeSync()
          },
    ),
    ...getAppendConnectionCloseErrors(params.appendConnections),
    getCloseSyncError(
      params.backgroundConnection === null
        ? null
        : () => {
            const backgroundConnection = params.backgroundConnection

            if (backgroundConnection === null) {
              return
            }

            backgroundConnection.closeSync()
          },
    ),
    getCloseSyncError(
      params.duckdbInstance === null
        ? null
        : () => {
            const duckdbInstance = params.duckdbInstance

            if (duckdbInstance === null) {
              return
            }

            duckdbInstance.closeSync()
          },
    ),
  ])

  if (closeError !== null) {
    writeRuntimeFailureLogEvent({
      attrs: {closeError},
      event: 'duckdb.startup.cleanup-failure',
      message: '[duckdb] failed to clean up embedded runtime',
      terminalArgs: [closeError],
    })
  }

  try {
    await releaseCurrentDuckdbOwnerLease()
  } catch (error) {
    resetDuckdbRuntimeState()
    return closeError === null
      ? getNormalizedDuckdbError(error)
      : getChainedDuckdbError(closeError, error, 'lease release failed')
  }

  resetDuckdbRuntimeState()
  return closeError
}

const startDuckdbProcess = async (): Promise<DuckDBConnection> => {
  const appendLaneCount = getDuckdbRuntimeConfigValue().appendLaneCount

  if (
    duckdbServiceState.controlConnection
    && duckdbServiceState.duckdbInstance
    && duckdbServiceState.appendConnections.length === appendLaneCount
  ) {
    return duckdbServiceState.controlConnection
  }

  const runtimeConfig = ensureDuckdbRuntimeDirectories(getDuckdbRuntimeConfigValue())
  let appendConnections: DuckDBConnection[] = []
  let backgroundConnection: DuckDBConnection | null = null
  let controlConnection: DuckDBConnection | null = null
  let duckdbInstance: DuckDBInstance | null = null

  const createAppendConnections = async (remainingCount: number): Promise<void> => {
    if (remainingCount === 0) {
      return
    }

    if (duckdbInstance === null) {
      throw new Error('DuckDB instance not started')
    }

    const nextAppendConnection = await duckdbInstance.connect()
    appendConnections = [...appendConnections, nextAppendConnection]
    return createAppendConnections(remainingCount - 1)
  }

  await ensureCurrentDuckdbOwnerLease()

  try {
    await runDuckdbStartupWalPreflight(runtimeConfig)
    duckdbInstance = await createDuckdbInstance(runtimeConfig)
    controlConnection = await duckdbInstance.connect()
    await createAppendConnections(appendLaneCount)
    backgroundConnection = await duckdbInstance.connect()

    duckdbServiceState.appendConnections = appendConnections
    duckdbServiceState.appendQueues = getInitialDuckdbAppendQueues(appendLaneCount)
    duckdbServiceState.appendPendingCountByLane = getInitialDuckdbAppendLaneMetrics(appendLaneCount)
    duckdbServiceState.appendMaxQueueDepthByLane = getInitialDuckdbAppendLaneMetrics(appendLaneCount)
    duckdbServiceState.backgroundConnection = backgroundConnection
    duckdbServiceState.backgroundQueue = Promise.resolve()
    duckdbServiceState.controlConnection = controlConnection
    duckdbServiceState.duckdbInstance = duckdbInstance
    duckdbServiceState.nextAppendLaneIndex = 0
    registerDuckdbShutdownHooks()

    return controlConnection
  } catch (error) {
    const cleanupError = await cleanupFailedDuckdbStart({
      appendConnections,
      backgroundConnection,
      controlConnection,
      duckdbInstance,
    })
    throw cleanupError === null ? error : getChainedDuckdbError(error, cleanupError, 'startup cleanup failed')
  }
}

const ensureStartedDuckdbProcess = async () => {
  const appendLaneCount = getDuckdbRuntimeConfigValue().appendLaneCount

  if (
    duckdbServiceState.backgroundConnection
    && duckdbServiceState.controlConnection
    && duckdbServiceState.duckdbInstance
    && duckdbServiceState.appendConnections.length === appendLaneCount
  ) {
    return duckdbServiceState.controlConnection
  }

  if (duckdbServiceState.startupPromise !== null) {
    return duckdbServiceState.startupPromise
  }

  const retryAfterRecoverableStartupFailure = async (error: unknown) => {
    if (!isDuckdbStartupRetryableError(error)) {
      throw error
    }

    writeRuntimeFailureLogEvent({
      attrs: {error},
      event: 'duckdb.startup.retry',
      message: '[duckdb] retrying startup after recoverable initialization failure',
      severity: 'WARN',
      terminalArgs: [error],
    })

    try {
      return await startDuckdbProcess()
    } catch (retryError) {
      if (!isDuckdbWalReplayRecoveryError(retryError)) {
        throw retryError
      }

      try {
        await quarantineFailedDuckdbWalReplay(getDuckdbRuntimeConfigValue(), retryError)
      } catch (recoveryError) {
        throw getChainedDuckdbError(retryError, recoveryError, 'WAL replay recovery failed')
      }

      try {
        return await startDuckdbProcess()
      } catch (recoveryRetryError) {
        throw getChainedDuckdbError(retryError, recoveryRetryError, 'WAL replay recovery retry failed')
      }
    }
  }

  duckdbServiceState.startupPromise = startDuckdbProcess()
    .catch(retryAfterRecoverableStartupFailure)
    .finally(() => {
      duckdbServiceState.startupPromise = null
    })

  return duckdbServiceState.startupPromise
}

const enqueueDuckdbWork = async <T>(work: () => Promise<T>): Promise<T> => {
  const queuedAtMs = Date.now()
  const diagnosticContext = duckdbWorkloadDiagnosticStorage.getStore()
  duckdbServiceState.duckdbPendingCount += 1
  duckdbServiceState.duckdbMaxQueueDepth = Math.max(
    duckdbServiceState.duckdbMaxQueueDepth,
    duckdbServiceState.duckdbPendingCount,
  )
  const runQueuedWork = async () => {
    const startedAtMs = Date.now()
    const waitMs = startedAtMs - queuedAtMs
    duckdbServiceState.duckdbLastWaitMs = waitMs
    duckdbServiceState.duckdbTasksStarted += 1
    duckdbServiceState.duckdbTotalWaitMs += waitMs

    try {
      return await work()
    } finally {
      const durationMs = Date.now() - startedAtMs
      duckdbServiceState.duckdbLastDurationMs = durationMs
      duckdbServiceState.duckdbTasksCompleted += 1
      duckdbServiceState.duckdbTotalDurationMs += durationMs
    }
  }
  const queuedWork = duckdbServiceState.duckdbQueue.then(() => {
    return diagnosticContext === undefined
      ? runQueuedWork()
      : duckdbWorkloadDiagnosticStorage.run(diagnosticContext, runQueuedWork)
  })
  duckdbServiceState.duckdbQueue = queuedWork.then(
    () => {
      duckdbServiceState.duckdbPendingCount = Math.max(0, duckdbServiceState.duckdbPendingCount - 1)
      return undefined
    },
    () => {
      duckdbServiceState.duckdbPendingCount = Math.max(0, duckdbServiceState.duckdbPendingCount - 1)
      return undefined
    },
  )
  return queuedWork
}

const enqueueDuckdbBackgroundWork = async <T>(work: () => Promise<T>): Promise<T> => {
  const queuedAtMs = Date.now()
  duckdbServiceState.backgroundPendingCount += 1
  duckdbServiceState.backgroundMaxQueueDepth = Math.max(
    duckdbServiceState.backgroundMaxQueueDepth,
    duckdbServiceState.backgroundPendingCount,
  )
  const queuedWork = duckdbServiceState.backgroundQueue.then(async () => {
    const startedAtMs = Date.now()
    const waitMs = startedAtMs - queuedAtMs
    duckdbServiceState.backgroundLastWaitMs = waitMs
    duckdbServiceState.backgroundTasksStarted += 1
    duckdbServiceState.backgroundTotalWaitMs += waitMs

    try {
      return await work()
    } finally {
      const durationMs = Date.now() - startedAtMs
      duckdbServiceState.backgroundLastDurationMs = durationMs
      duckdbServiceState.backgroundTasksCompleted += 1
      duckdbServiceState.backgroundTotalDurationMs += durationMs
    }
  })
  duckdbServiceState.backgroundQueue = queuedWork.then(
    () => {
      duckdbServiceState.backgroundPendingCount = Math.max(0, duckdbServiceState.backgroundPendingCount - 1)
      return undefined
    },
    () => {
      duckdbServiceState.backgroundPendingCount = Math.max(0, duckdbServiceState.backgroundPendingCount - 1)
      return undefined
    },
  )
  return queuedWork
}

const getDuckdbAppendQueueDepth = () => {
  return duckdbServiceState.appendPendingCountByLane.reduce((totalCount, currentCount) => {
    return totalCount + currentCount
  }, 0)
}

const incrementDuckdbAppendQueueDepth = (laneIndex: number) => {
  const nextQueueDepthByLane = duckdbServiceState.appendPendingCountByLane.map((currentCount, currentLaneIndex) => {
    return currentLaneIndex === laneIndex ? currentCount + 1 : currentCount
  })

  duckdbServiceState.appendPendingCountByLane = nextQueueDepthByLane
  duckdbServiceState.appendMaxQueueDepthByLane = duckdbServiceState.appendMaxQueueDepthByLane.map(
    (currentCount, currentLaneIndex) => {
      const nextLaneCount = nextQueueDepthByLane[currentLaneIndex] ?? 0
      return currentCount > nextLaneCount ? currentCount : nextLaneCount
    },
  )
}

const decrementDuckdbAppendQueueDepth = (laneIndex: number) => {
  duckdbServiceState.appendPendingCountByLane = duckdbServiceState.appendPendingCountByLane.map(
    (currentCount, currentLaneIndex) => {
      return currentLaneIndex === laneIndex ? Math.max(0, currentCount - 1) : currentCount
    },
  )
}

const recordDuckdbAppendBatchStart = () => {
  duckdbServiceState.appendTotalBatchesStarted += 1
}

const recordDuckdbAppendBatchCompletion = (durationMs: number) => {
  duckdbServiceState.appendLastDurationMs = durationMs
  duckdbServiceState.appendTotalBatchesCompleted += 1
  duckdbServiceState.appendTotalDurationMs += durationMs
}

const getNextDuckdbAppendLaneIndex = () => {
  const appendLaneCount = duckdbServiceState.appendConnections.length

  if (appendLaneCount === 0) {
    throw new Error('DuckDB append lanes not started')
  }

  const nextLaneIndex = duckdbServiceState.nextAppendLaneIndex % appendLaneCount
  duckdbServiceState.nextAppendLaneIndex = (nextLaneIndex + 1) % appendLaneCount
  return nextLaneIndex
}

const enqueueDuckdbAppendLaneWork = async <T>(
  laneIndex: number,
  work: (appendConnection: DuckDBConnection) => Promise<T>,
): Promise<T> => {
  incrementDuckdbAppendQueueDepth(laneIndex)
  const appendQueue = duckdbServiceState.appendQueues[laneIndex] ?? Promise.resolve()
  const queuedWork = appendQueue.then(async () => {
    const startedAtMs = Date.now()

    recordDuckdbAppendBatchStart()

    try {
      return await work(getDuckdbAppendConnection(laneIndex))
    } finally {
      recordDuckdbAppendBatchCompletion(Date.now() - startedAtMs)
    }
  })

  duckdbServiceState.appendQueues[laneIndex] = queuedWork.then(
    () => {
      decrementDuckdbAppendQueueDepth(laneIndex)
      return undefined
    },
    () => {
      decrementDuckdbAppendQueueDepth(laneIndex)
      return undefined
    },
  )

  return queuedWork
}

type DuckdbStatementSplitState = {buffer: string; inDouble: boolean; inSingle: boolean; statements: string[]}

const appendDuckdbStatementBuffer = (state: DuckdbStatementSplitState, value: string): DuckdbStatementSplitState => {
  return {...state, buffer: `${state.buffer}${value}`}
}

const flushDuckdbStatementBuffer = (state: DuckdbStatementSplitState): DuckdbStatementSplitState => {
  const trimmedStatement = state.buffer.trim()

  return trimmedStatement === ''
    ? {...state, buffer: ''}
    : {...state, buffer: '', statements: [...state.statements, trimmedStatement]}
}

const splitDuckdbStatementsStep = (
  sql: string,
  index: number,
  state: DuckdbStatementSplitState,
): DuckdbStatementSplitState => {
  if (index >= sql.length) {
    return flushDuckdbStatementBuffer(state)
  }

  const currentCharacter = sql[index] ?? ''
  const nextCharacter = sql[index + 1] ?? ''

  if (currentCharacter === "'" && state.inSingle && nextCharacter === "'") {
    return splitDuckdbStatementsStep(sql, index + 2, appendDuckdbStatementBuffer(state, "''"))
  }

  if (currentCharacter === '"' && state.inDouble && nextCharacter === '"') {
    return splitDuckdbStatementsStep(sql, index + 2, appendDuckdbStatementBuffer(state, '""'))
  }

  if (currentCharacter === "'" && !state.inDouble) {
    return splitDuckdbStatementsStep(sql, index + 1, {
      ...appendDuckdbStatementBuffer(state, currentCharacter),
      inSingle: !state.inSingle,
    })
  }

  if (currentCharacter === '"' && !state.inSingle) {
    return splitDuckdbStatementsStep(sql, index + 1, {
      ...appendDuckdbStatementBuffer(state, currentCharacter),
      inDouble: !state.inDouble,
    })
  }

  return currentCharacter === ';' && !state.inSingle && !state.inDouble
    ? splitDuckdbStatementsStep(sql, index + 1, flushDuckdbStatementBuffer(state))
    : splitDuckdbStatementsStep(sql, index + 1, appendDuckdbStatementBuffer(state, currentCharacter))
}

const splitDuckdbStatements = (statement: string) => {
  return splitDuckdbStatementsStep(statement, 0, {buffer: '', inDouble: false, inSingle: false, statements: []})
    .statements
}

const recordDuckdbControlTransactionStatement = (duckdbConnection: DuckDBConnection, statement: string) => {
  if (duckdbConnection !== duckdbServiceState.controlConnection) {
    return
  }

  const normalizedStatement = statement.trim()

  if (/^BEGIN\b/i.test(normalizedStatement)) {
    duckdbServiceState.controlTransactionDepth += 1
    return
  }

  if (/^(COMMIT|ROLLBACK)\b/i.test(normalizedStatement)) {
    duckdbServiceState.controlTransactionDepth = Math.max(0, duckdbServiceState.controlTransactionDepth - 1)
  }
}

const getDuckdbConnectionDiagnosticIdentity = (duckdbConnection: DuckDBConnection) => {
  if (duckdbConnection === duckdbServiceState.controlConnection) {
    return {connectionRole: 'control', lane: null}
  }

  if (duckdbConnection === duckdbServiceState.backgroundConnection) {
    return {connectionRole: 'background', lane: null}
  }

  const lane = duckdbServiceState.appendConnections.indexOf(duckdbConnection)
  return lane === -1 ? {connectionRole: 'unknown', lane: null} : {connectionRole: 'append', lane}
}

const getDuckdbStatementKind = (statement: string) => {
  return (
    statement
      .trim()
      .match(/^([A-Za-z]+)/)?.[1]
      ?.toUpperCase() ?? 'UNKNOWN'
  )
}

const getDuckdbStatementHash = (statement: string) => {
  return createHash('sha256').update(statement).digest('hex').slice(0, 12)
}

const getDuckdbStatementTargetTable = (statement: string) => {
  return (
    statement.match(/\b(?:INSERT\s+INTO|MERGE\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)?)/iu)?.[1]
    ?? statement.match(/\b(?:FROM|JOIN)\s+([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)?)/iu)?.[1]
    ?? null
  )
}

const recordDuckdbMutatingStatementTarget = (statement: string) => {
  const targetTable =
    statement.match(/\b(?:INSERT\s+INTO|MERGE\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)?)/iu)?.[1]
    ?? null

  if (targetTable !== null) {
    duckdbLastMutatingStatementTargetTable = targetTable
  }
}

const shouldWriteDuckdbStatementDiagnosticToStderr = () => {
  return ['1', 'true', 'yes', 'on'].includes(
    String(process.env.FORSKA_DUCKDB_STATEMENT_DIAGNOSTIC_STDERR ?? '')
      .trim()
      .toLowerCase(),
  )
}

const writeDuckdbStatementDiagnostic = ({
  duckdbConnection,
  durationMs,
  error,
  phase,
  statement,
  statementExecutionId,
}: {
  duckdbConnection: DuckDBConnection
  durationMs: number | null
  error: unknown
  phase: 'end' | 'error' | 'start'
  statement: string
  statementExecutionId: string
}) => {
  const diagnosticContext = duckdbWorkloadDiagnosticStorage.getStore()

  if (phase === 'start') {
    recordDuckdbMutatingStatementTarget(statement)
  }

  if (diagnosticContext === undefined) {
    return
  }

  const {connectionRole, lane} = getDuckdbConnectionDiagnosticIdentity(duckdbConnection)
  const workloadContext = diagnosticContext.context
  const diagnosticAttrs = {
    connectionRole,
    durationMs,
    errorName: error instanceof Error ? error.name : error === null ? null : typeof error,
    lane,
    operation: diagnosticContext.operation,
    phase,
    progress: null,
    progressSource: null,
    queue: diagnosticContext.queue,
    queueDepthAtStart: diagnosticContext.queueDepthAtStart,
    routeOrJobKey: workloadContext?.routeOrJobKey ?? `duckdb.${diagnosticContext.operation}`,
    statementExecutionId,
    statementHash: getDuckdbStatementHash(statement),
    statementKind: getDuckdbStatementKind(statement),
    statementTargetTable: getDuckdbStatementTargetTable(statement),
    workloadClass: workloadContext?.workloadClass ?? 'unclassified',
  }

  if (shouldWriteDuckdbStatementDiagnosticToStderr()) {
    console.error(`[duckdb:statement-diagnostic] ${JSON.stringify(diagnosticAttrs)}`)
  }

  try {
    writeRuntimeLogEvent({
      attrs: diagnosticAttrs,
      event: `duckdb.statement.${phase}`,
      message: `[duckdb] statement ${phase}`,
      severity: phase === 'error' ? 'ERROR' : 'INFO',
    })
  } catch {
    return
  }
}

const withDuckdbStatementDiagnostic = async <T>(
  duckdbConnection: DuckDBConnection,
  statement: string,
  work: () => Promise<T>,
): Promise<T> => {
  const statementExecutionId = randomUUID()
  const startedAtMs = Date.now()

  writeDuckdbStatementDiagnostic({
    duckdbConnection,
    durationMs: null,
    error: null,
    phase: 'start',
    statement,
    statementExecutionId,
  })

  try {
    const result = await work()
    writeDuckdbStatementDiagnostic({
      duckdbConnection,
      durationMs: Date.now() - startedAtMs,
      error: null,
      phase: 'end',
      statement,
      statementExecutionId,
    })
    return result
  } catch (error) {
    writeDuckdbStatementDiagnostic({
      duckdbConnection,
      durationMs: Date.now() - startedAtMs,
      error,
      phase: 'error',
      statement,
      statementExecutionId,
    })
    throw error
  }
}

const runDuckdbSingleStatement = async (duckdbConnection: DuckDBConnection, statement: string) => {
  await withDuckdbStatementDiagnostic(duckdbConnection, statement, () => {
    return duckdbConnection.run(statement)
  })
  recordDuckdbControlTransactionStatement(duckdbConnection, statement)
}

const runDuckdbSingleStatementAndReadAll = async <T>(
  duckdbConnection: DuckDBConnection,
  statement: string,
  values?: DuckdbBoundValues,
  types?: DuckdbBoundTypes,
): Promise<T[]> => {
  return withDuckdbStatementDiagnostic(duckdbConnection, statement, async () => {
    const reader = await duckdbConnection.runAndReadAll(statement, values, types)
    return reader.getRowObjectsJson() as T[]
  })
}

const runDuckdbStatementsDirect = async (
  duckdbConnection: DuckDBConnection,
  statements: string[],
  canRetryAfterRollback = true,
): Promise<void> => {
  try {
    const [currentStatement = ''] = statements

    if (!currentStatement) {
      return
    }

    await runDuckdbSingleStatement(duckdbConnection, currentStatement)
    return await runDuckdbStatementsDirect(duckdbConnection, statements.slice(1), canRetryAfterRollback)
  } catch (error) {
    const shouldRetryAfterRollback = canRetryAfterRollback && isDuckdbAbortedTransactionError(error)
    const shouldRollback = shouldRetryAfterRollback || hasDuckdbTransactionStart(statements)

    if (!shouldRollback) {
      throw error
    }

    const rollbackError = await getDuckdbRollbackError(duckdbConnection)

    if (rollbackError !== null) {
      throw getChainedDuckdbError(error, rollbackError, 'rollback failed')
    }

    if (!shouldRetryAfterRollback) {
      throw error
    }

    try {
      return await runDuckdbStatementsDirect(duckdbConnection, statements, false)
    } catch (retryError) {
      throw getChainedDuckdbError(error, retryError, 'rollback retry failed')
    }
  }
}

const runDuckdbStatementsAndReadLastDirect = async <T>(
  duckdbConnection: DuckDBConnection,
  statements: string[],
  canRetryAfterRollback = true,
): Promise<T[]> => {
  try {
    const [currentStatement = ''] = statements

    if (!currentStatement) {
      return []
    }

    if (statements.length === 1) {
      return await runDuckdbSingleStatementAndReadAll<T>(duckdbConnection, currentStatement)
    }

    await runDuckdbSingleStatement(duckdbConnection, currentStatement)
    return await runDuckdbStatementsAndReadLastDirect<T>(duckdbConnection, statements.slice(1), canRetryAfterRollback)
  } catch (error) {
    const shouldRetryAfterRollback = canRetryAfterRollback && isDuckdbAbortedTransactionError(error)
    const shouldRollback = shouldRetryAfterRollback || hasDuckdbTransactionStart(statements)

    if (!shouldRollback) {
      throw error
    }

    const rollbackError = await getDuckdbRollbackError(duckdbConnection)

    if (rollbackError !== null) {
      throw getChainedDuckdbError(error, rollbackError, 'rollback failed')
    }

    if (!shouldRetryAfterRollback) {
      throw error
    }

    try {
      return await runDuckdbStatementsAndReadLastDirect<T>(duckdbConnection, statements, false)
    } catch (retryError) {
      throw getChainedDuckdbError(error, retryError, 'rollback retry failed')
    }
  }
}

const hasDuckdbTransactionStart = (statements: string[]) => {
  return statements.some((statement) => {
    return /^BEGIN\b/i.test(statement.trim())
  })
}

const getDuckdbRollbackError = async (duckdbConnection?: DuckDBConnection): Promise<Error | null> => {
  try {
    await runDuckdbSingleStatement(duckdbConnection ?? getDuckdbConnection(), 'ROLLBACK')
    return null
  } catch (error) {
    return getNormalizedDuckdbError(error)
  }
}

const runDuckdbJsonQueryDirect = async <T>(statement: string): Promise<T[]> => {
  return runDuckdbStatementsAndReadLastDirect<T>(getDuckdbConnection(), splitDuckdbStatements(statement))
}

const runDuckdbStatementDirect = async (statement: string) => {
  await runDuckdbStatementsDirect(getDuckdbConnection(), splitDuckdbStatements(statement))
}

const runDuckdbBackgroundJsonQueryDirect = async <T>(statement: string): Promise<T[]> => {
  return runDuckdbStatementsAndReadLastDirect<T>(getDuckdbBackgroundConnection(), splitDuckdbStatements(statement))
}

const runDuckdbBackgroundStatementDirect = async (statement: string) => {
  await runDuckdbStatementsDirect(getDuckdbBackgroundConnection(), splitDuckdbStatements(statement))
}

const assertDuckdbAppendTransactionEnabled = () => {
  if (getEnv().FORSKA_DUCKDB_APPEND_TRANSACTION_ENABLED) {
    return
  }

  throw new Error('DuckDB append transactions require FORSKA_DUCKDB_APPEND_TRANSACTION_ENABLED=true')
}

export const getDuckdbRuntimeConfig = () => {
  return {...getDuckdbRuntimeConfigValue()}
}

export const getDuckdbTempSpillMetricsSnapshot = (): DuckdbTempSpillMetrics => {
  const tempDirectory = getDuckdbRuntimeConfigValue().tempDirectory

  if (tempDirectory === null) {
    return {available: false, error: null, fileCount: null, tempDirectory: null, totalBytes: null}
  }

  try {
    const snapshot = getDirectorySizeSnapshot(tempDirectory)

    return {...snapshot, available: true, error: null, tempDirectory}
  } catch (error) {
    return {
      available: false,
      error: getErrorMessage(error) ?? String(error),
      fileCount: null,
      tempDirectory,
      totalBytes: null,
    }
  }
}

export const getDuckdbBackgroundRuntimeDiagnostics = async (): Promise<DuckdbBackgroundRuntimeDiagnostics> => {
  const configured = getDuckdbRuntimeConfig()
  const [settingsRow] = await runDuckdbBackgroundJsonQuery<{
    checkpointThreshold: string | null
    memoryLimit: string | null
    preserveInsertionOrder: boolean | null
    tempDirectory: string | null
    threads: string | null
  }>(`
    SELECT
      current_setting('checkpoint_threshold') AS checkpointThreshold,
      current_setting('memory_limit') AS memoryLimit,
      current_setting('preserve_insertion_order') AS preserveInsertionOrder,
      current_setting('threads') AS threads,
      current_setting('temp_directory') AS tempDirectory
  `)

  return {
    configured,
    effective: {
      checkpointThreshold: settingsRow?.checkpointThreshold ?? null,
      memoryLimit: settingsRow?.memoryLimit ?? null,
      preserveInsertionOrder: settingsRow?.preserveInsertionOrder ?? null,
      tempDirectory: settingsRow?.tempDirectory ?? null,
      threads: settingsRow?.threads ?? null,
    },
    instanceOptions: getDuckdbInstanceOptions(configured),
    queues: getDuckdbQueueRuntimeMetricsSnapshot(),
    tempSpill: getDuckdbTempSpillMetricsSnapshot(),
    workloads: getDuckdbWorkloadRuntimeMetricsSnapshot(),
  }
}

export const getDuckdbQueueRuntimeMetricsSnapshot = (): DuckdbQueueRuntimeMetrics => {
  return {
    background: {
      lastDurationMs: duckdbServiceState.backgroundLastDurationMs,
      lastWaitMs: duckdbServiceState.backgroundLastWaitMs,
      maxQueueDepth: duckdbServiceState.backgroundMaxQueueDepth,
      queueDepth: duckdbServiceState.backgroundPendingCount,
      tasksCompleted: duckdbServiceState.backgroundTasksCompleted,
      tasksStarted: duckdbServiceState.backgroundTasksStarted,
      totalDurationMs: duckdbServiceState.backgroundTotalDurationMs,
      totalWaitMs: duckdbServiceState.backgroundTotalWaitMs,
    },
    main: {
      lastDurationMs: duckdbServiceState.duckdbLastDurationMs,
      lastWaitMs: duckdbServiceState.duckdbLastWaitMs,
      maxQueueDepth: duckdbServiceState.duckdbMaxQueueDepth,
      queueDepth: duckdbServiceState.duckdbPendingCount,
      tasksCompleted: duckdbServiceState.duckdbTasksCompleted,
      tasksStarted: duckdbServiceState.duckdbTasksStarted,
      totalDurationMs: duckdbServiceState.duckdbTotalDurationMs,
      totalWaitMs: duckdbServiceState.duckdbTotalWaitMs,
    },
  }
}

export const resetDuckdbServiceForTests = () => {
  const closeError = getCombinedCloseError([
    getCloseSyncError(
      duckdbServiceState.controlConnection === null
        ? null
        : () => {
            duckdbServiceState.controlConnection?.closeSync()
          },
    ),
    ...getAppendConnectionCloseErrors(duckdbServiceState.appendConnections),
    getCloseSyncError(
      duckdbServiceState.duckdbInstance === null
        ? null
        : () => {
            duckdbServiceState.duckdbInstance?.closeSync()
          },
    ),
  ])

  resetDuckdbRuntimeState()

  if (closeError) {
    throw closeError
  }
}

export const getDuckdbAppendRuntimeMetrics = (): DuckdbAppendRuntimeMetrics => {
  const queueDepthByLane = [...duckdbServiceState.appendPendingCountByLane]
  const maxQueueDepthByLane = [...duckdbServiceState.appendMaxQueueDepthByLane]

  return {
    batchesCompleted: duckdbServiceState.appendTotalBatchesCompleted,
    batchesStarted: duckdbServiceState.appendTotalBatchesStarted,
    laneCount: getDuckdbRuntimeConfigValue().appendLaneCount,
    lastDurationMs: duckdbServiceState.appendLastDurationMs,
    maxQueueDepth: maxQueueDepthByLane.reduce((maxCount, currentCount) => {
      return maxCount > currentCount ? maxCount : currentCount
    }, 0),
    maxQueueDepthByLane,
    queueDepth: getDuckdbAppendQueueDepth(),
    queueDepthByLane,
    totalDurationMs: duckdbServiceState.appendTotalDurationMs,
  }
}

const getDuckdbTempSpillTotalBytes = (snapshot: DuckdbTempSpillMetrics | null) => {
  return snapshot?.available === true ? snapshot.totalBytes : null
}

const getDuckdbTempSpillDeltaBytes = (before: DuckdbTempSpillMetrics | null, after: DuckdbTempSpillMetrics | null) => {
  const beforeBytes = getDuckdbTempSpillTotalBytes(before)
  const afterBytes = getDuckdbTempSpillTotalBytes(after)

  return beforeBytes === null || afterBytes === null ? null : Math.max(0, afterBytes - beforeBytes)
}

const getDuckdbWorkloadResultBytes = (value: unknown) => {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

const getDuckdbJsonWorkloadResultMetrics = <T>(rows: T[]): DuckdbWorkloadResultMetrics => {
  return {resultBytes: getDuckdbWorkloadResultBytes(rows), resultRows: rows.length}
}

const getDuckdbUnknownWorkloadResultMetrics = (result: unknown): DuckdbWorkloadResultMetrics => {
  return Array.isArray(result) ? getDuckdbJsonWorkloadResultMetrics(result) : {resultBytes: null, resultRows: null}
}

const getDuckdbNoWorkloadResultMetrics = (): DuckdbWorkloadResultMetrics => {
  return {resultBytes: null, resultRows: null}
}

const getDuckdbWorkloadBudgetFailure = (context: DuckdbWorkloadContext, metric: DuckdbWorkloadRuntimeMetric) => {
  if (context.maxResultRows !== undefined && metric.resultRows !== null && metric.resultRows > context.maxResultRows) {
    return `result rows ${metric.resultRows} exceeded budget ${context.maxResultRows}`
  }

  if (
    context.maxResultBytes !== undefined
    && metric.resultBytes !== null
    && metric.resultBytes > context.maxResultBytes
  ) {
    return `result bytes ${metric.resultBytes} exceeded budget ${context.maxResultBytes}`
  }

  if (context.allowsTempSpill === false && (metric.tempSpillDeltaBytes ?? 0) > 0) {
    return `temp spill ${metric.tempSpillDeltaBytes} bytes is not allowed`
  }

  if (context.timeoutMs !== undefined && metric.durationMs > context.timeoutMs) {
    return `duration ${metric.durationMs}ms exceeded timeout ${context.timeoutMs}ms`
  }

  return null
}

const recordDuckdbWorkloadRuntimeMetric = (metric: DuckdbWorkloadRuntimeMetric) => {
  duckdbServiceState.duckdbWorkloadMetrics = [...duckdbServiceState.duckdbWorkloadMetrics, metric].slice(
    -duckdbWorkloadMetricsLimit,
  )
}

const shouldEnforceForegroundDuckdbWorkloadContext = () => {
  const configuredValue = String(process.env.FORSKA_ENFORCE_DUCKDB_WORKLOAD_CONTEXT ?? '')
    .trim()
    .toLowerCase()

  return !['0', 'false', 'no', 'off'].includes(configuredValue)
}

const assertDuckdbWorkloadContextIsAllowed = (operation: DuckdbWorkloadOperation, context?: DuckdbWorkloadContext) => {
  if (
    context === undefined
    && shouldEnforceForegroundDuckdbWorkloadContext()
    && enforcedForegroundDuckdbOperations.has(operation)
    && !canCurrentServerOwnDuckdb()
  ) {
    throw new Error(`DuckDB ${operation} requires DuckdbWorkloadContext before connection acquisition`)
  }
}

const getDuckdbWorkloadRuntimeMetric = ({
  context,
  durationMs,
  error,
  operation,
  queue,
  queueDepthAtStart,
  resultMetrics,
  tempAfter,
  tempBefore,
}: {
  context: DuckdbWorkloadContext
  durationMs: number
  error: unknown
  operation: DuckdbWorkloadOperation
  queue: DuckdbWorkloadQueue
  queueDepthAtStart: number
  resultMetrics: DuckdbWorkloadResultMetrics
  tempAfter: DuckdbTempSpillMetrics | null
  tempBefore: DuckdbTempSpillMetrics | null
}): DuckdbWorkloadRuntimeMetric => {
  return {
    allowsTempSpill: context.allowsTempSpill ?? null,
    durationMs,
    error: error === null ? null : getCompactDuckdbErrorMessage(error),
    fallbackIntent: context.fallbackIntent ?? null,
    memoryLimit: getDuckdbRuntimeConfigValue().memoryLimit,
    operation,
    projectId: context.projectId ?? null,
    queue,
    queueDepthAtStart,
    recordedAt: new Date().toISOString(),
    resultBytes: resultMetrics.resultBytes,
    resultRows: resultMetrics.resultRows,
    routeOrJobKey: context.routeOrJobKey,
    searchMode: context.searchMode ?? null,
    tempDirectory: tempAfter?.tempDirectory ?? tempBefore?.tempDirectory ?? null,
    tempSpillDeltaBytes: getDuckdbTempSpillDeltaBytes(tempBefore, tempAfter),
    timeoutMs: context.timeoutMs ?? null,
    workloadClass: context.workloadClass,
  }
}

const assertDuckdbWorkloadBudget = (context: DuckdbWorkloadContext, metric: DuckdbWorkloadRuntimeMetric) => {
  const budgetFailure = getDuckdbWorkloadBudgetFailure(context, metric)

  if (budgetFailure !== null) {
    throw new Error(`DuckDB workload budget exceeded for ${context.routeOrJobKey}: ${budgetFailure}`)
  }
}

const withDuckdbWorkloadContext = <T>({
  context,
  getResultMetrics,
  operation,
  queue,
  queueDepthAtStart,
  work,
}: {
  context?: DuckdbWorkloadContext
  getResultMetrics: (result: T) => DuckdbWorkloadResultMetrics
  operation: DuckdbWorkloadOperation
  queue: DuckdbWorkloadQueue
  queueDepthAtStart: number
  work: () => Promise<T>
}) => {
  assertDuckdbWorkloadContextIsAllowed(operation, context)

  const diagnosticContext = context ?? duckdbWorkloadDiagnosticStorage.getStore()?.context

  const runWork = () => {
    return duckdbWorkloadDiagnosticStorage.run({context: diagnosticContext, operation, queue, queueDepthAtStart}, work)
  }

  if (context === undefined) {
    return runWork()
  }

  const startedAtMs = Date.now()
  const tempBefore = getDuckdbTempSpillMetricsSnapshot()

  return runWork().then(
    (result) => {
      const tempAfter = getDuckdbTempSpillMetricsSnapshot()
      const metric = getDuckdbWorkloadRuntimeMetric({
        context,
        durationMs: Date.now() - startedAtMs,
        error: null,
        operation,
        queue,
        queueDepthAtStart,
        resultMetrics: getResultMetrics(result),
        tempAfter,
        tempBefore,
      })

      recordDuckdbWorkloadRuntimeMetric(metric)
      assertDuckdbWorkloadBudget(context, metric)
      return result
    },
    (error) => {
      recordDuckdbWorkloadRuntimeMetric(
        getDuckdbWorkloadRuntimeMetric({
          context,
          durationMs: Date.now() - startedAtMs,
          error,
          operation,
          queue,
          queueDepthAtStart,
          resultMetrics: getDuckdbNoWorkloadResultMetrics(),
          tempAfter: getDuckdbTempSpillMetricsSnapshot(),
          tempBefore,
        }),
      )
      throw error
    },
  )
}

export const runWithDuckdbWorkloadDiagnosticContext = <T>(
  workloadContext: DuckdbWorkloadContext,
  work: () => Promise<T>,
) => {
  const diagnosticContext = duckdbWorkloadDiagnosticStorage.getStore()

  return diagnosticContext === undefined
    ? work()
    : duckdbWorkloadDiagnosticStorage.run({...diagnosticContext, context: workloadContext}, work)
}

export const getDuckdbWorkloadRuntimeMetricsSnapshot = () => {
  return [...duckdbServiceState.duckdbWorkloadMetrics]
}

export const runMeasuredDuckdbJsonWorkload = async <T>({
  operation,
  queue,
  queueDepthAtStart,
  workloadContext,
  work,
}: {
  operation: DuckdbWorkloadOperation
  queue: DuckdbWorkloadQueue
  queueDepthAtStart: number
  workloadContext?: DuckdbWorkloadContext
  work: () => Promise<T[]>
}): Promise<T[]> => {
  return withDuckdbWorkloadContext({
    context: workloadContext,
    getResultMetrics: getDuckdbJsonWorkloadResultMetrics,
    operation,
    queue,
    queueDepthAtStart,
    work,
  })
}

export const runDuckdbJsonQuery = async <T>(
  statement: string,
  workloadContext?: DuckdbWorkloadContext,
): Promise<T[]> => {
  return withDuckdbStatementErrorContext({
    label: 'duckdb main query',
    statement,
    work: () => {
      return withDuckdbWorkloadContext({
        context: workloadContext,
        getResultMetrics: getDuckdbJsonWorkloadResultMetrics,
        operation: 'mainQuery',
        queue: 'main',
        queueDepthAtStart: duckdbServiceState.duckdbPendingCount,
        work: async () => {
          await waitForDuckdbAppendBarrier()

          return withNormalizedDuckdbError(() => {
            return enqueueDuckdbWork(async () => {
              await ensureStartedDuckdbProcess()
              return runDuckdbJsonQueryDirect<T>(statement)
            })
          })
        },
      })
    },
  })
}

export const runDuckdbStatement = async (statement: string, workloadContext?: DuckdbWorkloadContext) => {
  await withDuckdbStatementErrorContext({
    label: 'duckdb main statement',
    statement,
    work: () => {
      return withDuckdbWorkloadContext({
        context: workloadContext,
        getResultMetrics: getDuckdbNoWorkloadResultMetrics,
        operation: 'mainStatement',
        queue: 'main',
        queueDepthAtStart: duckdbServiceState.duckdbPendingCount,
        work: async () => {
          await waitForDuckdbAppendBarrier()

          return withNormalizedDuckdbError(() => {
            return enqueueDuckdbWork(async () => {
              await ensureStartedDuckdbProcess()
              await runDuckdbStatementDirect(statement)
            })
          })
        },
      })
    },
  })
}

export const runDuckdbBackgroundJsonQuery = async <T>(
  statement: string,
  workloadContext?: DuckdbWorkloadContext,
): Promise<T[]> => {
  const queue = getDuckdbRuntimeConfigValue().serializeConcurrentWork ? 'main' : 'background'
  const queueDepthAtStart =
    queue === 'main' ? duckdbServiceState.duckdbPendingCount : duckdbServiceState.backgroundPendingCount

  return withDuckdbStatementErrorContext({
    label: 'duckdb background query',
    statement,
    work: () => {
      return withDuckdbWorkloadContext({
        context: workloadContext,
        getResultMetrics: getDuckdbJsonWorkloadResultMetrics,
        operation: 'backgroundQuery',
        queue,
        queueDepthAtStart,
        work: () => {
          return withNormalizedDuckdbError(() => {
            return waitForDuckdbAppendBarrier().then(() => {
              const enqueue = getDuckdbRuntimeConfigValue().serializeConcurrentWork
                ? enqueueDuckdbWork
                : enqueueDuckdbBackgroundWork

              return enqueue(async () => {
                await ensureStartedDuckdbProcess()
                return runDuckdbBackgroundJsonQueryDirect<T>(statement)
              })
            })
          })
        },
      })
    },
  })
}

export const runDuckdbBackgroundStatement = async (statement: string, workloadContext?: DuckdbWorkloadContext) => {
  const queue = getDuckdbRuntimeConfigValue().serializeConcurrentWork ? 'main' : 'background'
  const queueDepthAtStart =
    queue === 'main' ? duckdbServiceState.duckdbPendingCount : duckdbServiceState.backgroundPendingCount

  await withDuckdbStatementErrorContext({
    label: 'duckdb background statement',
    statement,
    work: () => {
      return withDuckdbWorkloadContext({
        context: workloadContext,
        getResultMetrics: getDuckdbNoWorkloadResultMetrics,
        operation: 'backgroundStatement',
        queue,
        queueDepthAtStart,
        work: () => {
          return withNormalizedDuckdbError(() => {
            return waitForDuckdbAppendBarrier().then(() => {
              const enqueue = getDuckdbRuntimeConfigValue().serializeConcurrentWork
                ? enqueueDuckdbWork
                : enqueueDuckdbBackgroundWork

              return enqueue(async () => {
                await ensureStartedDuckdbProcess()
                await runDuckdbBackgroundStatementDirect(statement)
              })
            })
          })
        },
      })
    },
  })
}

export const runDuckdbAppendJsonQuery = async <T>(
  statement: string,
  values?: DuckdbBoundValues,
  types?: DuckdbBoundTypes,
  workloadContext?: DuckdbWorkloadContext,
): Promise<T[]> => {
  const queue = getDuckdbRuntimeConfigValue().serializeConcurrentWork ? 'main' : 'append'
  const queueDepthAtStart = queue === 'main' ? duckdbServiceState.duckdbPendingCount : getDuckdbAppendQueueDepth()

  return withDuckdbStatementErrorContext({
    label: 'duckdb append query',
    statement,
    work: () => {
      return withDuckdbWorkloadContext({
        context: workloadContext,
        getResultMetrics: getDuckdbJsonWorkloadResultMetrics,
        operation: 'appendQuery',
        queue,
        queueDepthAtStart,
        work: () => {
          return withNormalizedDuckdbError(async () => {
            await waitForDuckdbAppendBarrier()
            await ensureStartedDuckdbProcess()
            const appendLaneIndex = getNextDuckdbAppendLaneIndex()

            return getDuckdbRuntimeConfigValue().serializeConcurrentWork
              ? enqueueDuckdbWork(async () => {
                  const startedAtMs = Date.now()

                  incrementDuckdbAppendQueueDepth(appendLaneIndex)
                  recordDuckdbAppendBatchStart()

                  try {
                    const appendConnection = getDuckdbAppendConnection(appendLaneIndex)

                    return values === undefined && types === undefined
                      ? runDuckdbStatementsAndReadLastDirect<T>(appendConnection, splitDuckdbStatements(statement))
                      : runDuckdbSingleStatementAndReadAll<T>(appendConnection, statement, values, types)
                  } finally {
                    decrementDuckdbAppendQueueDepth(appendLaneIndex)
                    recordDuckdbAppendBatchCompletion(Date.now() - startedAtMs)
                  }
                })
              : enqueueDuckdbAppendLaneWork(appendLaneIndex, (appendConnection) => {
                  return values === undefined && types === undefined
                    ? runDuckdbStatementsAndReadLastDirect<T>(appendConnection, splitDuckdbStatements(statement))
                    : runDuckdbSingleStatementAndReadAll<T>(appendConnection, statement, values, types)
                })
          })
        },
      })
    },
  })
}

const runDuckdbAppendTransactionDirect = async <T>(
  appendConnection: DuckDBConnection,
  work: (runner: DuckdbTransactionRunner) => Promise<T>,
): Promise<T> => {
  await runDuckdbStatementsDirect(appendConnection, ['BEGIN TRANSACTION'])

  try {
    const result = await work({
      queryJson: async <T>(statement: string) => {
        return runDuckdbStatementsAndReadLastDirect<T>(appendConnection, splitDuckdbStatements(statement))
      },
      run: async (statement: string) => {
        await runDuckdbStatementsDirect(appendConnection, splitDuckdbStatements(statement))
      },
    })

    await runDuckdbStatementsDirect(appendConnection, ['COMMIT'])
    return result
  } catch (error) {
    const rollbackError = await getDuckdbRollbackError(appendConnection)

    throw rollbackError === null ? error : getChainedDuckdbError(error, rollbackError, 'rollback failed')
  }
}

export const runDuckdbAppendTransaction = async <T>(
  work: (runner: DuckdbTransactionRunner) => Promise<T>,
  workloadContext?: DuckdbWorkloadContext,
): Promise<T> => {
  assertDuckdbAppendTransactionEnabled()

  const queue = getDuckdbRuntimeConfigValue().serializeConcurrentWork ? 'main' : 'append'
  const queueDepthAtStart = queue === 'main' ? duckdbServiceState.duckdbPendingCount : getDuckdbAppendQueueDepth()

  return withDuckdbWorkloadContext({
    context: workloadContext,
    getResultMetrics: getDuckdbUnknownWorkloadResultMetrics,
    operation: 'appendTransaction',
    queue,
    queueDepthAtStart,
    work: () => {
      return withNormalizedDuckdbError(async () => {
        await waitForDuckdbAppendBarrier()
        await ensureStartedDuckdbProcess()
        const appendLaneIndex = getNextDuckdbAppendLaneIndex()

        return getDuckdbRuntimeConfigValue().serializeConcurrentWork
          ? enqueueDuckdbWork(async () => {
              const startedAtMs = Date.now()

              incrementDuckdbAppendQueueDepth(appendLaneIndex)
              recordDuckdbAppendBatchStart()

              try {
                return runDuckdbAppendTransactionDirect(getDuckdbAppendConnection(appendLaneIndex), work)
              } finally {
                decrementDuckdbAppendQueueDepth(appendLaneIndex)
                recordDuckdbAppendBatchCompletion(Date.now() - startedAtMs)
              }
            })
          : enqueueDuckdbAppendLaneWork(appendLaneIndex, (appendConnection) => {
              return runDuckdbAppendTransactionDirect(appendConnection, work)
            })
      })
    },
  })
}

export const runDuckdbTransaction = async <T>(
  work: (runner: DuckdbTransactionRunner) => Promise<T>,
  workloadContext?: DuckdbWorkloadContext,
): Promise<T> => {
  return withDuckdbWorkloadContext({
    context: workloadContext,
    getResultMetrics: getDuckdbUnknownWorkloadResultMetrics,
    operation: 'transaction',
    queue: 'main',
    queueDepthAtStart: duckdbServiceState.duckdbPendingCount,
    work: async () => {
      return withDuckdbAppendBarrier(async () => {
        return withNormalizedDuckdbError(() => {
          return enqueueDuckdbWork(async () => {
            await ensureStartedDuckdbProcess()
            await runDuckdbStatementDirect('BEGIN TRANSACTION')

            try {
              const result = await work({
                queryJson: async <T>(statement: string) => {
                  return runDuckdbJsonQueryDirect<T>(statement)
                },
                run: async (statement: string) => {
                  await runDuckdbStatementDirect(statement)
                },
              })

              await runDuckdbStatementDirect('COMMIT')
              return result
            } catch (error) {
              const rollbackError = await getDuckdbRollbackError()

              throw rollbackError === null ? error : getChainedDuckdbError(error, rollbackError, 'rollback failed')
            }
          })
        })
      })
    },
  })
}

export const runDuckdbMaintenance = async (
  command: 'checkpoint' | 'force_checkpoint',
  workloadContext?: DuckdbWorkloadContext,
) => {
  const statement = command === 'checkpoint' ? 'CHECKPOINT' : 'PRAGMA force_checkpoint'
  await withDuckdbWorkloadContext({
    context: workloadContext,
    getResultMetrics: getDuckdbNoWorkloadResultMetrics,
    operation: 'maintenance',
    queue: 'main',
    queueDepthAtStart: duckdbServiceState.duckdbPendingCount,
    work: async () => {
      await waitForDuckdbAppendBarrier()

      return withNormalizedDuckdbError(() => {
        return enqueueDuckdbWork(async () => {
          await ensureStartedDuckdbProcess()
          await withDuckdbAppendBarrier(async () => {
            await runDuckdbStatementDirect(statement)
          })
        })
      })
    },
  })
}

const materializeCopiedDuckdbSnapshot = async (snapshotPath: string, runtimeConfig: DuckdbRuntimeConfig) => {
  const duckdbInstance = await DuckDBInstance.create(snapshotPath, getDuckdbInstanceOptions(runtimeConfig))
  const connection = await duckdbInstance.connect()

  try {
    await connection.run('SELECT 1')
  } finally {
    connection.closeSync()
    duckdbInstance.closeSync()
  }
}

const shouldCheckpointBeforeDuckdbSnapshotCopy = (runtimeConfig: DuckdbRuntimeConfig) => {
  return runtimeConfig.databasePath !== ':memory:'
}

const checkpointBeforeDuckdbSnapshotCopy = async () => {
  await runDuckdbStatementDirect('CHECKPOINT').catch((error) => {
    writeRuntimeOperatorLogEvent({
      attrs: {error: getCompactDuckdbErrorMessage(error)},
      event: 'duckdb.snapshot.pre-copy-checkpoint-failed',
      message: '[duckdb] snapshot pre-copy checkpoint failed; aborting snapshot to avoid stale WAL-backed copy',
      severity: 'WARN',
    })
    throw error
  })
}

const copyDuckdbSnapshot = (runtimeConfig: DuckdbRuntimeConfig): Effect.Effect<DuckdbSnapshot, unknown, never> => {
  return Effect.gen(function* () {
    if (runtimeConfig.databasePath === ':memory:') {
      yield* Effect.fail(new Error('DuckDB snapshots are not available for :memory: databases'))
    }

    const createdAt = new Date().toISOString()
    const snapshotName = `${basename(runtimeConfig.databasePath)}.${createdAt.replaceAll(':', '-')}.${randomUUID()}.duckdb`
    const snapshotPath = join(duckdbSnapshotDirectory, snapshotName)

    yield* Effect.tryPromise(() => {
      return mkdir(duckdbSnapshotDirectory, {recursive: true})
    })
    yield* Effect.tryPromise(() => {
      return rm(snapshotPath, {force: true})
    })
    if (shouldCheckpointBeforeDuckdbSnapshotCopy(runtimeConfig)) {
      yield* Effect.tryPromise(() => {
        return checkpointBeforeDuckdbSnapshotCopy()
      })
    }
    yield* Effect.tryPromise(async () => {
      try {
        await copyFile(runtimeConfig.databasePath, snapshotPath)
        await materializeCopiedDuckdbSnapshot(snapshotPath, runtimeConfig)
      } catch (error) {
        await rm(snapshotPath, {force: true})
        await rm(`${snapshotPath}.wal`, {force: true})
        throw error
      }
    })

    return {createdAt, snapshotPath} satisfies DuckdbSnapshot
  })
}

export const createDuckdbSnapshot = async (): Promise<DuckdbSnapshot> => {
  return withNormalizedDuckdbError(() => {
    return enqueueDuckdbWork(async () => {
      await ensureStartedDuckdbProcess()
      return withDuckdbAppendBarrier(() => {
        return Effect.runPromise(copyDuckdbSnapshot(getDuckdbRuntimeConfigValue()))
      })
    })
  })
}

export const deleteDuckdbSnapshot = async (snapshotPath: string) => {
  await withNormalizedDuckdbError(async () => {
    const snapshotWalPath = `${snapshotPath}.wal`
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.tryPromise(() => {
          return rm(snapshotPath, {force: true})
        })
        yield* Effect.tryPromise(() => {
          return rm(snapshotWalPath, {force: true})
        })
      }),
    )
  })
}

export const closeDuckdbService = async (options: CloseDuckdbServiceOptions = {}) => {
  await withDuckdbAppendBarrier(async () => {
    await enqueueDuckdbWork(async () => {
      await closeDuckdbServiceWithoutBarrier(options)
    })
  })
}

export const recoverDuckdbServiceAfterFatalError = async (error: unknown, options: CloseDuckdbServiceOptions = {}) => {
  await recoverDuckdbRuntimeAfterFatalError(error, options)
}

registerDuckdbOwnerDemotionHandler(async () => {
  if (duckdbServiceState.controlConnection !== null || duckdbServiceState.duckdbInstance !== null) {
    await closeDuckdbService()
  }
})
