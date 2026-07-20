import {DuckDBInstance} from '@duckdb/node-api'
import {Effect} from 'effect'

import {type AppDatabaseSnapshot, getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {getSqlLiteral} from '../src/server/services/appQueryHelpers.ts'
import {createDuckdbSnapshotForCli} from '../src/server/utils/duckdbScriptAccess.ts'
import {getReadOnlyDuckdbRuntimeOptions} from '../src/server/utils/duckdbService.ts'

type QuerySection = {rows: unknown[]; sql: string}
type CliOptions = {projectId: string; limit: number}

const defaultProjectId = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'

const getArgValue = (names: string[]) => {
  const matchedArgument = process.argv.slice(2).find((argument) => {
    return names.some((name) => {
      return argument.startsWith(`${name}=`)
    })
  })

  return matchedArgument?.slice(matchedArgument.indexOf('=') + 1).trim()
}

const getPositiveIntegerOption = (value: string | undefined, fallback: number) => {
  const parsedValue = value === undefined ? Number.NaN : Number(value)

  return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : fallback
}

const getCliOptions = (): CliOptions => {
  return {
    limit: getPositiveIntegerOption(getArgValue(['--limit']), 25),
    projectId: getArgValue(['--project-id', '--projectId']) ?? defaultProjectId,
  }
}

const deleteSnapshot = (snapshot: AppDatabaseSnapshot) => {
  return Effect.tryPromise(() => {
    return getAppDatabaseService().deleteSnapshot(snapshot.snapshotPath)
  }).pipe(
    Effect.catchAll((error) => {
      return Effect.sync(() => {
        console.error('[inspectReviewServingProjectState] failed to delete snapshot', {
          error,
          snapshotPath: snapshot.snapshotPath,
        })
      })
    }),
  )
}

const getSnapshotQueryRuntime = async (snapshotPath: string) => {
  const duckdbInstance = await DuckDBInstance.create(snapshotPath, getReadOnlyDuckdbRuntimeOptions())
  const connection = await duckdbInstance.connect()

  return {connection, duckdbInstance}
}

const closeSnapshotQueryRuntime = (runtime: Awaited<ReturnType<typeof getSnapshotQueryRuntime>>) => {
  return Effect.sync(() => {
    runtime.connection.closeSync()
    runtime.duckdbInstance.closeSync()
  })
}

const runReadonlyQuery = async (runtime: Awaited<ReturnType<typeof getSnapshotQueryRuntime>>, sql: string) => {
  const reader = await runtime.connection.runAndReadAll(sql)
  return reader.getRowObjectsJson()
}

const querySection = async (
  runtime: Awaited<ReturnType<typeof getSnapshotQueryRuntime>>,
  sql: string,
): Promise<QuerySection> => {
  return {rows: await runReadonlyQuery(runtime, sql), sql}
}

const getDuplicateQuery = (params: {
  keyColumns: readonly string[]
  limit: number
  projectId: string
  snapshotColumn?: string
  table: string
}) => {
  const keySql = params.keyColumns.join(', ')
  const snapshotColumns = params.snapshotColumn
    ? `, ${params.snapshotColumn} AS snapshotId`
    : ''
  const snapshotGroup = params.snapshotColumn ? `, ${params.snapshotColumn}` : ''

  return `
    SELECT ${keySql}${snapshotColumns}, CAST(COUNT(*) AS INTEGER) AS duplicateCount
    FROM ${params.table}
    WHERE project_id = ${getSqlLiteral(params.projectId)}
    GROUP BY ${keySql}${snapshotGroup}
    HAVING COUNT(*) > 1
    ORDER BY duplicateCount DESC
    LIMIT ${params.limit}
  `
}

const inspectProjectState = async (
  runtime: Awaited<ReturnType<typeof getSnapshotQueryRuntime>>,
  options: CliOptions,
) => {
  const projectIdSql = getSqlLiteral(options.projectId)
  const limit = options.limit

  const sections: Record<string, QuerySection> = {}

  sections.project = await querySection(
    runtime,
    `
      SELECT id, name, archived, updated_at AS updatedAt
      FROM app.project
      WHERE id = ${projectIdSql}
    `,
  )
  sections.snapshots = await querySection(
    runtime,
    `
      SELECT
        project_id AS projectId,
        snapshot_id AS snapshotId,
        snapshot_status AS status,
        review_config_hash AS reviewConfigHash,
        selected_import_snapshot_id AS selectedImportSnapshotId,
        last_known_good_snapshot_id AS lastKnownGoodSnapshotId,
        created_at AS createdAt,
        updated_at AS updatedAt,
        activated_at AS activatedAt,
        failed_at AS failedAt,
        last_error AS lastError,
        CAST(component_state_json AS VARCHAR) AS componentStateJson,
        CAST(validation_result_json AS VARCHAR) AS validationResultJson
      FROM app.review_serving_snapshot_manifest
      WHERE project_id = ${projectIdSql}
      ORDER BY updated_at DESC, snapshot_id DESC
      LIMIT ${limit}
    `,
  )
  sections.snapshotComponents = await querySection(
    runtime,
    `
      WITH component AS (
        SELECT
          snapshot.project_id AS projectId,
          snapshot.snapshot_id AS snapshotId,
          snapshot.snapshot_status AS snapshotStatus,
          'required' AS requirement,
          json_extract_string(component.value, '$.component') AS component,
          json_extract_string(component.value, '$.projectionIdentity') AS projectionIdentity,
          json_extract_string(component.value, '$.status') AS status,
          json_extract_string(component.value, '$.snapshotId') AS componentSnapshotId,
          json_extract_string(component.value, '$.selectedImportSnapshotId') AS selectedImportSnapshotId
        FROM app.review_serving_snapshot_manifest snapshot, json_each(json_extract(snapshot.component_state_json, '$.required')) component
        WHERE snapshot.project_id = ${projectIdSql}
        UNION ALL
        SELECT
          snapshot.project_id AS projectId,
          snapshot.snapshot_id AS snapshotId,
          snapshot.snapshot_status AS snapshotStatus,
          'optional' AS requirement,
          json_extract_string(component.value, '$.component') AS component,
          json_extract_string(component.value, '$.projectionIdentity') AS projectionIdentity,
          json_extract_string(component.value, '$.status') AS status,
          json_extract_string(component.value, '$.snapshotId') AS componentSnapshotId,
          json_extract_string(component.value, '$.selectedImportSnapshotId') AS selectedImportSnapshotId
        FROM app.review_serving_snapshot_manifest snapshot, json_each(json_extract(snapshot.component_state_json, '$.optional')) component
        WHERE snapshot.project_id = ${projectIdSql}
      )
      SELECT *
      FROM component
      ORDER BY snapshotStatus, requirement, component, projectionIdentity
      LIMIT ${limit * 4}
    `,
  )
  sections.selectedImportSnapshots = await querySection(
    runtime,
    `
      SELECT
        selected_import_snapshot_id AS selectedImportSnapshotId,
        project_id AS projectId,
        project_scope_identity AS projectScopeIdentity,
        source_delta_high_water AS sourceDeltaHighWater,
        status,
        started_at AS startedAt,
        completed_at AS completedAt,
        lease_owner AS leaseOwner,
        lease_expires_at AS leaseExpiresAt,
        last_error AS lastError,
        updated_at AS updatedAt
      FROM app.review_selected_import_snapshot
      WHERE project_id = ${projectIdSql}
      ORDER BY updated_at DESC, selected_import_snapshot_id DESC
      LIMIT ${limit}
    `,
  )
  sections.projectionManifests = await querySection(
    runtime,
    `
      SELECT
        manifest_id AS manifestId,
        project_id AS projectId,
        projection_component AS projectionComponent,
        projection_identity AS projectionIdentity,
        base_generation AS baseGeneration,
        patch_watermark AS patchWatermark,
        input_watermark AS inputWatermark,
        status,
        invalidation_reason AS invalidationReason,
        updated_at AS updatedAt
      FROM app.review_projection_identity_manifest
      WHERE project_id = ${projectIdSql}
      ORDER BY updated_at DESC, projection_component ASC, projection_identity ASC
      LIMIT ${limit * 2}
    `,
  )
  sections.rebuildRequests = await querySection(
    runtime,
    `
      SELECT
        request_id AS requestId,
        project_id AS projectId,
        status,
        reason,
        priority,
        requested_components_json AS requestedComponentsJson,
        CAST(identity_json AS VARCHAR) AS identityJson,
        CAST(diagnostics_json AS VARCHAR) AS diagnosticsJson,
        created_at AS createdAt,
        updated_at AS updatedAt,
        completed_at AS completedAt,
        failed_at AS failedAt,
        last_error AS lastError
      FROM app.review_rebuild_request
      WHERE project_id = ${projectIdSql}
      ORDER BY updated_at DESC, request_id DESC
      LIMIT ${limit}
    `,
  )
  sections.rebuildChunksByStatus = await querySection(
    runtime,
    `
      SELECT
        request_id AS requestId,
        projection_component AS projectionComponent,
        status,
        admission_state AS admissionState,
        CAST(COUNT(*) AS INTEGER) AS chunkCount,
        MIN(updated_at) AS oldestUpdatedAt,
        MAX(updated_at) AS newestUpdatedAt
      FROM app.review_rebuild_chunk_manifest
      WHERE project_id = ${projectIdSql}
      GROUP BY request_id, projection_component, status, admission_state
      ORDER BY newestUpdatedAt DESC, requestId DESC NULLS LAST, projectionComponent ASC
      LIMIT ${limit * 2}
    `,
  )
  sections.rebuildChunkErrors = await querySection(
    runtime,
    `
      SELECT
        chunk_id AS chunkId,
        request_id AS requestId,
        projection_component AS projectionComponent,
        status,
        admission_state AS admissionState,
        retry_count AS retryCount,
        oom_category AS oomCategory,
        chunk_start_key AS chunkStartKey,
        chunk_end_key AS chunkEndKey,
        last_error AS lastError,
        updated_at AS updatedAt
      FROM app.review_rebuild_chunk_manifest
      WHERE project_id = ${projectIdSql}
        AND (status <> 'completed' OR last_error IS NOT NULL)
      ORDER BY updated_at DESC, chunk_id DESC
      LIMIT ${limit}
    `,
  )
  sections.titleSearchDuplicateKeys = await querySection(
    runtime,
    getDuplicateQuery({
      keyColumns: ['project_id', 'search_identity', 'project_scope_identity', 'snapshot_id', 'token', 'article_id'],
      limit,
      projectId: options.projectId,
      table: 'mart.review_title_search_serving_v4',
    }),
  )
  sections.selectedImportDuplicateKeys = await querySection(
    runtime,
    getDuplicateQuery({
      keyColumns: ['project_id', 'project_scope_identity', 'selected_import_snapshot_id', 'article_id'],
      limit,
      projectId: options.projectId,
      table: 'app.review_selected_article_import_v4',
    }),
  )
  sections.filterPostingStatsDuplicateKeys = await querySection(
    runtime,
    getDuplicateQuery({
      keyColumns: ['project_id', 'review_config_hash', 'snapshot_id', 'filter_kind', 'filter_value', 'list_mode_key'],
      limit,
      projectId: options.projectId,
      table: 'mart.review_filter_posting_stats_v4',
    }),
  )
  sections.snapshotManifestDuplicateKeys = await querySection(
    runtime,
    getDuplicateQuery({
      keyColumns: ['project_id', 'snapshot_id'],
      limit,
      projectId: options.projectId,
      table: 'app.review_serving_snapshot_manifest',
    }),
  )
  sections.rebuildChunkManifestDuplicateKeys = await querySection(
    runtime,
    getDuplicateQuery({
      keyColumns: ['chunk_id'],
      limit,
      projectId: options.projectId,
      table: 'app.review_rebuild_chunk_manifest',
    }),
  )

  return sections
}

const inspectProjectStateFromSnapshot = (options: CliOptions) => {
  return Effect.acquireRelease(Effect.tryPromise(createDuckdbSnapshotForCli), deleteSnapshot).pipe(
    Effect.flatMap((snapshot) => {
      return Effect.acquireRelease(
        Effect.tryPromise(() => {
          return getSnapshotQueryRuntime(snapshot.snapshotPath)
        }),
        closeSnapshotQueryRuntime,
      ).pipe(
        Effect.flatMap((runtime) => {
          return Effect.tryPromise(async () => {
            const sections = await inspectProjectState(runtime, options)

            console.log(
              JSON.stringify(
                {
                  inspectedAt: new Date().toISOString(),
                  mode: 'readonly-snapshot',
                  options,
                  snapshotPath: snapshot.snapshotPath,
                  sections,
                },
                null,
                2,
              ),
            )
          })
        }),
      )
    }),
  )
}

if (import.meta.main) {
  await Effect.runPromise(Effect.scoped(inspectProjectStateFromSnapshot(getCliOptions())))
}
