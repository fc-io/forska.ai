import type {ProjectMartDirtyMaterializationStateRecord} from '../../db/schemaTypes.ts'
import {getAppDatabaseService} from './appDatabaseService.ts'
import {getSqlLiteral, getTimestampLiteral} from './appQueryHelpers.ts'

type DirtyMaterializationRunner = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

type DirtyMaterializationSourceSnapshot = {
  sourceScopeExpectedRowCount?: number | null
  sourceScopeFingerprint?: string | null
  sourceScopeGeneration?: number | null
  sourceScopeHighWaterArticleCreatedAt?: Date | null
  sourceScopeHighWaterArticleId?: string | null
}

type QueueDirtyMaterializationParams = DirtyMaterializationSourceSnapshot & {
  now?: Date
  projectId: string
  runner?: DirtyMaterializationRunner
  sourceKind: string
  targetDirtyToken: number
}

type ClaimDirtyMaterializationsParams = {
  leaseMs: number
  limit: number
  now?: Date
  sourceKind?: string
  workerId: string
}

type DirtyMaterializationFence = DirtyMaterializationSourceSnapshot & {
  materializationOwner: string
  now?: Date
  projectId: string
  sourceKind: string
  targetDirtyToken: number
}

type HeartbeatDirtyMaterializationParams = DirtyMaterializationFence & {leaseMs: number}

type AdvanceDirtyMaterializationCursorParams = DirtyMaterializationFence & {
  cursorArticleCreatedAt?: Date | null
  cursorArticleId?: string | null
  insertedRowCountDelta: number
}

type CompleteDirtyMaterializationParams = DirtyMaterializationFence

type RequeueDirtyMaterializationParams = {
  now?: Date
  projectId: string
  runner?: DirtyMaterializationRunner
  sourceKind: string
  targetDirtyToken: number
}

type FailDirtyMaterializationParams = DirtyMaterializationFence & {error: string}

type GetProjectScopeDirtyMaterializationSnapshotParams = {projectId: string; runner?: DirtyMaterializationRunner}

type GetCompletedDirtyMaterializationTokenParams = DirtyMaterializationSourceSnapshot & {
  projectId: string
  sourceKind: string
  targetDirtyToken: number
}

type MaterializeProjectScopeDirtyBatchParams = DirtyMaterializationFence & {batchSize: number}

type DirtyMaterializationClaim = {
  leaseExpiresAt: Date
  materializationOwner: string
  projectId: string
  sourceKind: string
  sourceScopeExpectedRowCount: number | null
  sourceScopeFingerprint: string | null
  sourceScopeGeneration: number | null
  sourceScopeHighWaterArticleCreatedAt: Date | null
  sourceScopeHighWaterArticleId: string | null
  targetDirtyToken: number
}

type DirtyMaterializationBatchResult = {
  insertedRowCountDelta: number
  isComplete: boolean
  materializationState: ProjectMartDirtyMaterializationStateRecord | null
}

type ProjectScopeDirtyMaterializationSnapshot = {
  sourceScopeExpectedRowCount: number
  sourceScopeFingerprint: string | null
  sourceScopeGeneration: number
  sourceScopeHighWaterArticleCreatedAt: Date | null
  sourceScopeHighWaterArticleId: string | null
}

type NormalizedDirtyMaterializationSourceSnapshot = {
  sourceScopeExpectedRowCount: number | null
  sourceScopeFingerprint: string | null
  sourceScopeGeneration: number | null
  sourceScopeHighWaterArticleCreatedAt: Date | null
  sourceScopeHighWaterArticleId: string | null
}

const projectScopeDirtyMaterializationSourceKind = 'project_scope_article'
const projectScopeDirtyMaterializationSourceChangedError =
  'project scope source changed before dirty materialization completed'

const withDirtyMaterializationTransaction = async <T>(
  runner: DirtyMaterializationRunner | undefined,
  work: (tx: DirtyMaterializationRunner) => Promise<T>,
) => {
  return runner ? work(runner) : (getAppDatabaseService().transaction(work) as Promise<T>)
}

const getNow = (value?: Date) => {
  return value ?? new Date()
}

const getLeaseExpiry = (now: Date, leaseMs: number) => {
  return new Date(now.getTime() + leaseMs)
}

const getNormalizedLimit = (limit: number) => {
  return Math.max(0, Math.floor(limit))
}

const getNormalizedInsertedRowCountDelta = (insertedRowCountDelta: number) => {
  return Math.max(0, Math.floor(insertedRowCountDelta))
}

const getNormalizedBatchSize = (batchSize: number) => {
  return Math.max(0, Math.floor(batchSize))
}

const getSourceSnapshot = (
  snapshot: DirtyMaterializationSourceSnapshot,
): NormalizedDirtyMaterializationSourceSnapshot => {
  return {
    sourceScopeExpectedRowCount: snapshot.sourceScopeExpectedRowCount ?? null,
    sourceScopeFingerprint: snapshot.sourceScopeFingerprint ?? null,
    sourceScopeGeneration: snapshot.sourceScopeGeneration ?? null,
    sourceScopeHighWaterArticleCreatedAt: snapshot.sourceScopeHighWaterArticleCreatedAt ?? null,
    sourceScopeHighWaterArticleId: snapshot.sourceScopeHighWaterArticleId ?? null,
  }
}

const getSourceSnapshotFromMaterializationState = (state: ProjectMartDirtyMaterializationStateRecord) => {
  return getSourceSnapshot({
    sourceScopeExpectedRowCount: state.sourceScopeExpectedRowCount,
    sourceScopeFingerprint: state.sourceScopeFingerprint,
    sourceScopeGeneration: state.sourceScopeGeneration,
    sourceScopeHighWaterArticleCreatedAt: state.sourceScopeHighWaterArticleCreatedAt,
    sourceScopeHighWaterArticleId: state.sourceScopeHighWaterArticleId,
  })
}

const withStatisticsPropagationDisabled = async <T>(
  runner: DirtyMaterializationRunner,
  work: () => Promise<T>,
): Promise<T> => {
  await runner.run("SET disabled_optimizers = 'statistics_propagation'")

  try {
    return await work()
  } finally {
    await runner.run("SET disabled_optimizers = ''")
  }
}

const getSourceSnapshotFenceSql = (snapshot: DirtyMaterializationSourceSnapshot, tableAlias = '') => {
  const prefix = tableAlias ? `${tableAlias}.` : ''
  const normalizedSnapshot = getSourceSnapshot(snapshot)

  return `
    AND ${prefix}source_scope_generation IS NOT DISTINCT FROM ${getSqlLiteral(normalizedSnapshot.sourceScopeGeneration)}
    AND ${prefix}source_scope_high_water_article_created_at IS NOT DISTINCT FROM ${getSqlLiteral(normalizedSnapshot.sourceScopeHighWaterArticleCreatedAt)}
    AND ${prefix}source_scope_high_water_article_id IS NOT DISTINCT FROM ${getSqlLiteral(normalizedSnapshot.sourceScopeHighWaterArticleId)}
    AND ${prefix}source_scope_fingerprint IS NOT DISTINCT FROM ${getSqlLiteral(normalizedSnapshot.sourceScopeFingerprint)}
    AND ${prefix}source_scope_expected_row_count IS NOT DISTINCT FROM ${getSqlLiteral(normalizedSnapshot.sourceScopeExpectedRowCount)}
  `
}

const getDirtyMaterializationStateSelectSql = () => {
  return `
    SELECT
      project_id AS projectId,
      source_kind AS sourceKind,
      CAST(target_dirty_token AS INTEGER) AS targetDirtyToken,
      cursor_article_created_at AS cursorArticleCreatedAt,
      cursor_article_id AS cursorArticleId,
      CAST(inserted_row_count AS INTEGER) AS insertedRowCount,
      CAST(source_scope_generation AS INTEGER) AS sourceScopeGeneration,
      source_scope_high_water_article_created_at AS sourceScopeHighWaterArticleCreatedAt,
      source_scope_high_water_article_id AS sourceScopeHighWaterArticleId,
      source_scope_fingerprint AS sourceScopeFingerprint,
      CAST(source_scope_expected_row_count AS INTEGER) AS sourceScopeExpectedRowCount,
      materialization_status AS materializationStatus,
      materialization_owner AS materializationOwner,
      lease_expires_at AS leaseExpiresAt,
      last_started_at AS lastStartedAt,
      last_completed_at AS lastCompletedAt,
      last_failed_at AS lastFailedAt,
      last_error AS lastError,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM app.project_mart_dirty_materialization_state
  `
}

const getDirtyMaterializationStateRecord = async (
  runner: DirtyMaterializationRunner,
  params: {projectId: string; sourceKind: string; targetDirtyToken: number},
) => {
  const [row] = await runner.queryJson<ProjectMartDirtyMaterializationStateRecord>(`
    ${getDirtyMaterializationStateSelectSql()}
    WHERE project_id = ${getSqlLiteral(params.projectId)}
      AND source_kind = ${getSqlLiteral(params.sourceKind)}
      AND target_dirty_token = ${params.targetDirtyToken}
    LIMIT 1
  `)

  return row ?? null
}

const getProjectScopeDirtyMaterializationSourceSql = (projectId: string) => {
  const projectLiteral = getSqlLiteral(projectId)

  return `
    current_curated_scope AS (
      SELECT
        project_article.project_id,
        project_article.article_id,
        article.article_created_at
      FROM app.project_article project_article
      INNER JOIN app.project project ON project.id = project_article.project_id
      INNER JOIN app.article article ON article.id = project_article.article_id
      WHERE project_article.project_id = ${projectLiteral}
        AND project.archived = FALSE
        AND (project.date_from IS NULL OR article.article_created_at >= project.date_from)
        AND (project.date_to IS NULL OR article.article_created_at <= project.date_to)
    ),
    current_route_scope AS (
      SELECT
        project_import_route.project_id,
        article_import_route.article_id,
        article.article_created_at
      FROM app.project_import_route project_import_route
      INNER JOIN app.article_import_route article_import_route
        ON article_import_route.import_route_id = project_import_route.import_route_id
      INNER JOIN app.project project ON project.id = project_import_route.project_id
      INNER JOIN app.article article ON article.id = article_import_route.article_id
      WHERE project_import_route.project_id = ${projectLiteral}
        AND project.archived = FALSE
        AND (project.date_from IS NULL OR article.article_created_at >= project.date_from)
        AND (project.date_to IS NULL OR article.article_created_at <= project.date_to)
    ),
    existing_mart_scope AS (
      SELECT
        scope_article.project_id,
        scope_article.article_id,
        scope_article.article_created_at
      FROM mart.project_scope_article scope_article
      INNER JOIN app.project project ON project.id = scope_article.project_id
      WHERE scope_article.project_id = ${projectLiteral}
        AND project.archived = FALSE
    ),
    combined_scope AS (
      SELECT * FROM current_curated_scope
      UNION ALL
      SELECT * FROM current_route_scope
      UNION ALL
      SELECT * FROM existing_mart_scope
    ),
    project_scope_dirty_source AS (
      SELECT
        project_id,
        article_id,
        MAX(article_created_at) AS article_created_at
      FROM combined_scope
      GROUP BY project_id, article_id
    )
  `
}

const getProjectScopeHighWaterPredicateSql = (
  snapshot: DirtyMaterializationSourceSnapshot,
  articleCreatedAtColumn: string,
  articleIdColumn: string,
) => {
  const sourceSnapshot = getSourceSnapshot(snapshot)

  return sourceSnapshot.sourceScopeHighWaterArticleId === null
    ? 'AND FALSE'
    : `
      AND (
        COALESCE(${articleCreatedAtColumn}, TIMESTAMPTZ '1970-01-01T00:00:00.000Z')
          < COALESCE(${getSqlLiteral(sourceSnapshot.sourceScopeHighWaterArticleCreatedAt)}, TIMESTAMPTZ '1970-01-01T00:00:00.000Z')
        OR (
          COALESCE(${articleCreatedAtColumn}, TIMESTAMPTZ '1970-01-01T00:00:00.000Z')
            = COALESCE(${getSqlLiteral(sourceSnapshot.sourceScopeHighWaterArticleCreatedAt)}, TIMESTAMPTZ '1970-01-01T00:00:00.000Z')
          AND ${articleIdColumn} <= ${getSqlLiteral(sourceSnapshot.sourceScopeHighWaterArticleId)}
        )
      )
    `
}

const getProjectScopeCursorPredicateSql = (
  cursor: {cursorArticleCreatedAt: Date | null; cursorArticleId: string | null},
  articleCreatedAtColumn: string,
  articleIdColumn: string,
) => {
  return cursor.cursorArticleId === null
    ? ''
    : `
      AND (
        COALESCE(${articleCreatedAtColumn}, TIMESTAMPTZ '1970-01-01T00:00:00.000Z')
          > COALESCE(${getSqlLiteral(cursor.cursorArticleCreatedAt)}, TIMESTAMPTZ '1970-01-01T00:00:00.000Z')
        OR (
          COALESCE(${articleCreatedAtColumn}, TIMESTAMPTZ '1970-01-01T00:00:00.000Z')
            = COALESCE(${getSqlLiteral(cursor.cursorArticleCreatedAt)}, TIMESTAMPTZ '1970-01-01T00:00:00.000Z')
          AND ${articleIdColumn} > ${getSqlLiteral(cursor.cursorArticleId)}
        )
      )
    `
}

const getProjectScopeOrderSql = (articleCreatedAtColumn: string, articleIdColumn: string) => {
  return `COALESCE(${articleCreatedAtColumn}, TIMESTAMPTZ '1970-01-01T00:00:00.000Z') ASC, ${articleIdColumn} ASC`
}

const getProjectScopeReverseOrderSql = (articleCreatedAtColumn: string, articleIdColumn: string) => {
  return `COALESCE(${articleCreatedAtColumn}, TIMESTAMPTZ '1970-01-01T00:00:00.000Z') DESC, ${articleIdColumn} DESC`
}

const getProjectScopeDirtyMaterializationSnapshot = async ({
  projectId,
  runner,
}: GetProjectScopeDirtyMaterializationSnapshotParams): Promise<ProjectScopeDirtyMaterializationSnapshot> => {
  const activeRunner = runner ?? getAppDatabaseService()

  return withStatisticsPropagationDisabled(activeRunner, async () => {
    const [sourceGeneration] = await activeRunner.queryJson<{sourceScopeGeneration: number}>(`
      SELECT COALESCE(MAX(active_generation), 0) AS sourceScopeGeneration
      FROM app.project_review_serving_generation
      WHERE project_id = ${getSqlLiteral(projectId)}
    `)
    const [sourceSummary] = await activeRunner.queryJson<{
      sourceScopeExpectedRowCount: number
      sourceScopeFingerprint: string | null
    }>(`
      WITH
      ${getProjectScopeDirtyMaterializationSourceSql(projectId)},
      source_summary AS (
        SELECT
          CAST(COUNT(*) AS INTEGER) AS sourceScopeExpectedRowCount,
          CASE
            WHEN COUNT(*) = 0 THEN NULL
            ELSE md5(
              CAST(COUNT(*) AS VARCHAR)
              || '|'
              || COALESCE(CAST(SUM(CAST(hash(article_id || '|' || COALESCE(CAST(article_created_at AS VARCHAR), 'NULL')) AS HUGEINT)) AS VARCHAR), '0')
              || '|'
              || COALESCE(MIN(article_id || '|' || COALESCE(CAST(article_created_at AS VARCHAR), 'NULL')), '')
              || '|'
              || COALESCE(MAX(article_id || '|' || COALESCE(CAST(article_created_at AS VARCHAR), 'NULL')), '')
            )
          END AS sourceScopeFingerprint
        FROM project_scope_dirty_source
      )
      SELECT
        sourceScopeExpectedRowCount,
        sourceScopeFingerprint
      FROM source_summary
    `)
    const [sourceHighWater] = await activeRunner.queryJson<{
      sourceScopeHighWaterArticleCreatedAt: Date | null
      sourceScopeHighWaterArticleId: string | null
    }>(`
      WITH
      ${getProjectScopeDirtyMaterializationSourceSql(projectId)}
        SELECT
          article_created_at AS sourceScopeHighWaterArticleCreatedAt,
          article_id AS sourceScopeHighWaterArticleId
        FROM project_scope_dirty_source
        ORDER BY ${getProjectScopeReverseOrderSql('article_created_at', 'article_id')}
        LIMIT 1
    `)

    return {
      sourceScopeExpectedRowCount: Number(sourceSummary?.sourceScopeExpectedRowCount ?? 0),
      sourceScopeFingerprint: sourceSummary?.sourceScopeFingerprint ?? null,
      sourceScopeGeneration: Number(sourceGeneration?.sourceScopeGeneration ?? 0),
      sourceScopeHighWaterArticleCreatedAt: sourceHighWater?.sourceScopeHighWaterArticleCreatedAt ?? null,
      sourceScopeHighWaterArticleId: sourceHighWater?.sourceScopeHighWaterArticleId ?? null,
    }
  })
}

const queueDirtyMaterialization = async ({
  now,
  projectId,
  runner,
  sourceKind,
  targetDirtyToken,
  ...snapshot
}: QueueDirtyMaterializationParams) => {
  const activeRunner = runner ?? getAppDatabaseService()
  const currentNow = getNow(now)
  const sourceSnapshot = getSourceSnapshot(snapshot)

  await activeRunner.run(`
    INSERT INTO app.project_mart_dirty_materialization_state (
      project_id,
      source_kind,
      target_dirty_token,
      source_scope_generation,
      source_scope_high_water_article_created_at,
      source_scope_high_water_article_id,
      source_scope_fingerprint,
      source_scope_expected_row_count,
      materialization_status,
      created_at,
      updated_at
    ) VALUES (
      ${getSqlLiteral(projectId)},
      ${getSqlLiteral(sourceKind)},
      ${targetDirtyToken},
      ${getSqlLiteral(sourceSnapshot.sourceScopeGeneration)},
      ${getSqlLiteral(sourceSnapshot.sourceScopeHighWaterArticleCreatedAt)},
      ${getSqlLiteral(sourceSnapshot.sourceScopeHighWaterArticleId)},
      ${getSqlLiteral(sourceSnapshot.sourceScopeFingerprint)},
      ${getSqlLiteral(sourceSnapshot.sourceScopeExpectedRowCount)},
      'pending',
      ${getTimestampLiteral(currentNow)},
      ${getTimestampLiteral(currentNow)}
    )
    ON CONFLICT(project_id, source_kind, target_dirty_token) DO UPDATE SET
      source_scope_generation = EXCLUDED.source_scope_generation,
      source_scope_high_water_article_created_at = EXCLUDED.source_scope_high_water_article_created_at,
      source_scope_high_water_article_id = EXCLUDED.source_scope_high_water_article_id,
      source_scope_fingerprint = EXCLUDED.source_scope_fingerprint,
      source_scope_expected_row_count = EXCLUDED.source_scope_expected_row_count,
      cursor_article_created_at = NULL,
      cursor_article_id = NULL,
      inserted_row_count = 0,
      materialization_status = 'pending',
      materialization_owner = NULL,
      lease_expires_at = NULL,
      last_error = NULL,
      updated_at = EXCLUDED.updated_at
  `)

  return getDirtyMaterializationStateRecord(activeRunner, {projectId, sourceKind, targetDirtyToken})
}

const requeueDirtyMaterialization = async ({
  now,
  projectId,
  runner,
  sourceKind,
  targetDirtyToken,
}: RequeueDirtyMaterializationParams) => {
  const currentNow = getNow(now)

  return withDirtyMaterializationTransaction(runner, async (tx) => {
    const currentState = await getDirtyMaterializationStateRecord(tx, {projectId, sourceKind, targetDirtyToken})

    if (currentState === null) {
      return null
    }

    const sourceSnapshot =
      sourceKind === projectScopeDirtyMaterializationSourceKind
        ? await getProjectScopeDirtyMaterializationSnapshot({projectId, runner: tx})
        : getSourceSnapshotFromMaterializationState(currentState)

    return queueDirtyMaterialization({
      ...sourceSnapshot,
      now: currentNow,
      projectId,
      runner: tx,
      sourceKind,
      targetDirtyToken,
    })
  })
}

const claimDirtyMaterializations = async ({
  leaseMs,
  limit,
  now,
  sourceKind,
  workerId,
}: ClaimDirtyMaterializationsParams): Promise<DirtyMaterializationClaim[]> => {
  const normalizedLimit = getNormalizedLimit(limit)

  if (normalizedLimit === 0) {
    return []
  }

  const currentNow = getNow(now)
  const leaseExpiresAt = getLeaseExpiry(currentNow, leaseMs)
  const claimableRows = await getAppDatabaseService().queryJson<DirtyMaterializationClaim>(`
    SELECT
      project_id AS projectId,
      source_kind AS sourceKind,
      CAST(target_dirty_token AS INTEGER) AS targetDirtyToken,
      CAST(source_scope_generation AS INTEGER) AS sourceScopeGeneration,
      source_scope_high_water_article_created_at AS sourceScopeHighWaterArticleCreatedAt,
      source_scope_high_water_article_id AS sourceScopeHighWaterArticleId,
      source_scope_fingerprint AS sourceScopeFingerprint,
      CAST(source_scope_expected_row_count AS INTEGER) AS sourceScopeExpectedRowCount,
      ${getSqlLiteral(workerId)} AS materializationOwner,
      ${getTimestampLiteral(leaseExpiresAt)} AS leaseExpiresAt
    FROM app.project_mart_dirty_materialization_state
    WHERE (${getSqlLiteral(sourceKind ?? null)} IS NULL OR source_kind = ${getSqlLiteral(sourceKind ?? null)})
      AND (
        materialization_status IN ('pending', 'failed')
        OR (
          materialization_status = 'running'
          AND (
            lease_expires_at IS NULL
            OR lease_expires_at <= ${getTimestampLiteral(currentNow)}
          )
        )
      )
    ORDER BY target_dirty_token ASC, project_id ASC, source_kind ASC
    LIMIT ${normalizedLimit}
  `)

  return claimableRows.reduce<Promise<DirtyMaterializationClaim[]>>(async (accPromise, row) => {
    const acc = await accPromise
    const [claimed] = await getAppDatabaseService().queryJson<DirtyMaterializationClaim>(`
      UPDATE app.project_mart_dirty_materialization_state
      SET
        materialization_status = 'running',
        materialization_owner = ${getSqlLiteral(workerId)},
        lease_expires_at = ${getTimestampLiteral(leaseExpiresAt)},
        last_started_at = ${getTimestampLiteral(currentNow)},
        last_error = NULL,
        updated_at = ${getTimestampLiteral(currentNow)}
      WHERE project_id = ${getSqlLiteral(row.projectId)}
        AND source_kind = ${getSqlLiteral(row.sourceKind)}
        AND target_dirty_token = ${row.targetDirtyToken}
        ${getSourceSnapshotFenceSql(row)}
        AND (
          materialization_status IN ('pending', 'failed')
          OR (
            materialization_status = 'running'
            AND (
              lease_expires_at IS NULL
              OR lease_expires_at <= ${getTimestampLiteral(currentNow)}
            )
          )
        )
      RETURNING
        project_id AS projectId,
        source_kind AS sourceKind,
        CAST(target_dirty_token AS INTEGER) AS targetDirtyToken,
        CAST(source_scope_generation AS INTEGER) AS sourceScopeGeneration,
        source_scope_high_water_article_created_at AS sourceScopeHighWaterArticleCreatedAt,
        source_scope_high_water_article_id AS sourceScopeHighWaterArticleId,
        source_scope_fingerprint AS sourceScopeFingerprint,
        CAST(source_scope_expected_row_count AS INTEGER) AS sourceScopeExpectedRowCount,
        materialization_owner AS materializationOwner,
        lease_expires_at AS leaseExpiresAt
    `)

    return claimed ? [...acc, claimed] : acc
  }, Promise.resolve([]))
}

const getClaimedDirtyMaterialization = async ({
  materializationOwner,
  now,
  projectId,
  sourceKind,
  targetDirtyToken,
  ...snapshot
}: DirtyMaterializationFence) => {
  const currentNow = getNow(now)
  const [row] = await getAppDatabaseService().queryJson<ProjectMartDirtyMaterializationStateRecord>(`
    ${getDirtyMaterializationStateSelectSql()}
    WHERE project_id = ${getSqlLiteral(projectId)}
      AND source_kind = ${getSqlLiteral(sourceKind)}
      AND target_dirty_token = ${targetDirtyToken}
      ${getSourceSnapshotFenceSql(snapshot)}
      AND materialization_status = 'running'
      AND materialization_owner = ${getSqlLiteral(materializationOwner)}
      AND lease_expires_at > ${getTimestampLiteral(currentNow)}
    LIMIT 1
  `)

  return row ?? null
}

const heartbeatDirtyMaterialization = async ({
  leaseMs,
  materializationOwner,
  now,
  projectId,
  sourceKind,
  targetDirtyToken,
  ...snapshot
}: HeartbeatDirtyMaterializationParams) => {
  const currentNow = getNow(now)
  const leaseExpiresAt = getLeaseExpiry(currentNow, leaseMs)
  const [row] = await getAppDatabaseService().queryJson<ProjectMartDirtyMaterializationStateRecord>(`
    UPDATE app.project_mart_dirty_materialization_state
    SET
      lease_expires_at = ${getTimestampLiteral(leaseExpiresAt)},
      updated_at = ${getTimestampLiteral(currentNow)}
    WHERE project_id = ${getSqlLiteral(projectId)}
      AND source_kind = ${getSqlLiteral(sourceKind)}
      AND target_dirty_token = ${targetDirtyToken}
      ${getSourceSnapshotFenceSql(snapshot)}
      AND materialization_status = 'running'
      AND materialization_owner = ${getSqlLiteral(materializationOwner)}
      AND lease_expires_at > ${getTimestampLiteral(currentNow)}
    RETURNING *
  `)

  return row
    ? getDirtyMaterializationStateRecord(getAppDatabaseService(), {projectId, sourceKind, targetDirtyToken})
    : null
}

const advanceDirtyMaterializationCursor = async ({
  cursorArticleCreatedAt,
  cursorArticleId,
  insertedRowCountDelta,
  materializationOwner,
  now,
  projectId,
  sourceKind,
  targetDirtyToken,
  ...snapshot
}: AdvanceDirtyMaterializationCursorParams) => {
  const currentNow = getNow(now)
  const normalizedInsertedRowCountDelta = getNormalizedInsertedRowCountDelta(insertedRowCountDelta)
  const [row] = await getAppDatabaseService().queryJson<ProjectMartDirtyMaterializationStateRecord>(`
    UPDATE app.project_mart_dirty_materialization_state
    SET
      cursor_article_created_at = ${cursorArticleCreatedAt === undefined ? 'cursor_article_created_at' : getSqlLiteral(cursorArticleCreatedAt)},
      cursor_article_id = ${cursorArticleId === undefined ? 'cursor_article_id' : getSqlLiteral(cursorArticleId)},
      inserted_row_count = inserted_row_count + ${normalizedInsertedRowCountDelta},
      updated_at = ${getTimestampLiteral(currentNow)}
    WHERE project_id = ${getSqlLiteral(projectId)}
      AND source_kind = ${getSqlLiteral(sourceKind)}
      AND target_dirty_token = ${targetDirtyToken}
      ${getSourceSnapshotFenceSql(snapshot)}
      AND materialization_status = 'running'
      AND materialization_owner = ${getSqlLiteral(materializationOwner)}
      AND lease_expires_at > ${getTimestampLiteral(currentNow)}
    RETURNING *
  `)

  return row
    ? getDirtyMaterializationStateRecord(getAppDatabaseService(), {projectId, sourceKind, targetDirtyToken})
    : null
}

const getComparableDateValue = (value: unknown) => {
  const date = value instanceof Date || typeof value === 'string' || typeof value === 'number' ? new Date(value) : null

  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null
}

const isSameSourceSnapshot = (left: DirtyMaterializationSourceSnapshot, right: DirtyMaterializationSourceSnapshot) => {
  const normalizedLeft = getSourceSnapshot(left)
  const normalizedRight = getSourceSnapshot(right)

  return (
    normalizedLeft.sourceScopeGeneration === normalizedRight.sourceScopeGeneration
    && normalizedLeft.sourceScopeExpectedRowCount === normalizedRight.sourceScopeExpectedRowCount
    && normalizedLeft.sourceScopeHighWaterArticleId === normalizedRight.sourceScopeHighWaterArticleId
    && normalizedLeft.sourceScopeFingerprint === normalizedRight.sourceScopeFingerprint
    && getComparableDateValue(normalizedLeft.sourceScopeHighWaterArticleCreatedAt)
      === getComparableDateValue(normalizedRight.sourceScopeHighWaterArticleCreatedAt)
  )
}

const markDirtyMaterializationUnreconciled = async ({
  currentNow,
  error,
  materializationOwner,
  projectId,
  sourceKind,
  targetDirtyToken,
  tx,
  ...snapshot
}: DirtyMaterializationFence & {currentNow: Date; error: string; tx: DirtyMaterializationRunner}) => {
  const [row] = await tx.queryJson<ProjectMartDirtyMaterializationStateRecord>(`
    UPDATE app.project_mart_dirty_materialization_state
    SET
      materialization_status = 'unreconciled',
      materialization_owner = NULL,
      lease_expires_at = NULL,
      last_failed_at = ${getTimestampLiteral(currentNow)},
      last_error = ${getSqlLiteral(error)},
      updated_at = ${getTimestampLiteral(currentNow)}
    WHERE project_id = ${getSqlLiteral(projectId)}
      AND source_kind = ${getSqlLiteral(sourceKind)}
      AND target_dirty_token = ${targetDirtyToken}
      ${getSourceSnapshotFenceSql(snapshot)}
      AND materialization_status = 'running'
      AND materialization_owner = ${getSqlLiteral(materializationOwner)}
      AND lease_expires_at > ${getTimestampLiteral(currentNow)}
    RETURNING *
  `)

  return row ? getDirtyMaterializationStateRecord(tx, {projectId, sourceKind, targetDirtyToken}) : null
}

const reconcileProjectScopeDirtyMaterialization = async ({
  materializationState,
  projectId,
  tx,
}: {
  materializationState: ProjectMartDirtyMaterializationStateRecord
  projectId: string
  tx: DirtyMaterializationRunner
}) => {
  const sourceSnapshot = getSourceSnapshot(materializationState)

  if (sourceSnapshot.sourceScopeExpectedRowCount === null) {
    return {error: null}
  }

  const currentSnapshot = await getProjectScopeDirtyMaterializationSnapshot({projectId, runner: tx})
  const [insertedRows] = await tx.queryJson<{insertedRowCount: number}>(`
    SELECT CAST(COUNT(*) AS INTEGER) AS insertedRowCount
    FROM app.project_mart_refresh_article_state
    WHERE project_id = ${getSqlLiteral(projectId)}
      AND first_dirty_token <= ${materializationState.targetDirtyToken}
      AND last_dirty_token >= ${materializationState.targetDirtyToken}
  `)
  const insertedRowCount = Number(insertedRows?.insertedRowCount ?? 0)

  if (!isSameSourceSnapshot(sourceSnapshot, currentSnapshot)) {
    return {error: projectScopeDirtyMaterializationSourceChangedError}
  }

  if (insertedRowCount !== sourceSnapshot.sourceScopeExpectedRowCount) {
    return {
      error: `dirty materialization inserted ${insertedRowCount} rows but expected ${sourceSnapshot.sourceScopeExpectedRowCount}`,
    }
  }

  if (materializationState.insertedRowCount !== sourceSnapshot.sourceScopeExpectedRowCount) {
    return {
      error: `dirty materialization recorded ${materializationState.insertedRowCount} rows but expected ${sourceSnapshot.sourceScopeExpectedRowCount}`,
    }
  }

  return {error: null}
}

const getClaimedDirtyMaterializationRecord = async ({
  currentNow,
  materializationOwner,
  projectId,
  sourceKind,
  targetDirtyToken,
  tx,
  ...snapshot
}: DirtyMaterializationFence & {currentNow: Date; tx: DirtyMaterializationRunner}) => {
  const [materializationState] = await tx.queryJson<ProjectMartDirtyMaterializationStateRecord>(`
    ${getDirtyMaterializationStateSelectSql()}
    WHERE project_id = ${getSqlLiteral(projectId)}
      AND source_kind = ${getSqlLiteral(sourceKind)}
      AND target_dirty_token = ${targetDirtyToken}
      ${getSourceSnapshotFenceSql(snapshot)}
      AND materialization_status = 'running'
      AND materialization_owner = ${getSqlLiteral(materializationOwner)}
      AND lease_expires_at > ${getTimestampLiteral(currentNow)}
    LIMIT 1
  `)

  return materializationState ?? null
}

const completeDirtyMaterializationWithRunner = async ({
  currentNow,
  materializationOwner,
  projectId,
  sourceKind,
  targetDirtyToken,
  tx,
  ...snapshot
}: DirtyMaterializationFence & {currentNow: Date; tx: DirtyMaterializationRunner}) => {
  const materializationState = await getClaimedDirtyMaterializationRecord({
    currentNow,
    materializationOwner,
    projectId,
    sourceKind,
    targetDirtyToken,
    tx,
    ...snapshot,
  })

  if (!materializationState) {
    return null
  }

  const reconciliation =
    sourceKind === projectScopeDirtyMaterializationSourceKind
      ? await reconcileProjectScopeDirtyMaterialization({materializationState, projectId, tx})
      : {error: null}

  if (reconciliation.error !== null) {
    return reconciliation.error === projectScopeDirtyMaterializationSourceChangedError
      ? requeueDirtyMaterialization({now: currentNow, projectId, runner: tx, sourceKind, targetDirtyToken})
      : markDirtyMaterializationUnreconciled({
          currentNow,
          error: reconciliation.error,
          materializationOwner,
          projectId,
          sourceKind,
          targetDirtyToken,
          tx,
          ...snapshot,
        }).then(() => {
          return null
        })
  }

  const [row] = await tx.queryJson<ProjectMartDirtyMaterializationStateRecord>(`
    UPDATE app.project_mart_dirty_materialization_state
    SET
      materialization_status = 'completed',
      materialization_owner = NULL,
      lease_expires_at = NULL,
      last_completed_at = ${getTimestampLiteral(currentNow)},
      last_error = NULL,
      updated_at = ${getTimestampLiteral(currentNow)}
    WHERE project_id = ${getSqlLiteral(projectId)}
      AND source_kind = ${getSqlLiteral(sourceKind)}
      AND target_dirty_token = ${targetDirtyToken}
      ${getSourceSnapshotFenceSql(snapshot)}
      AND materialization_status = 'running'
      AND materialization_owner = ${getSqlLiteral(materializationOwner)}
      AND lease_expires_at > ${getTimestampLiteral(currentNow)}
    RETURNING *
  `)

  return row ? getDirtyMaterializationStateRecord(tx, {projectId, sourceKind, targetDirtyToken}) : null
}

const completeDirtyMaterialization = async ({
  materializationOwner,
  now,
  projectId,
  sourceKind,
  targetDirtyToken,
  ...snapshot
}: CompleteDirtyMaterializationParams) => {
  const currentNow = getNow(now)

  return getAppDatabaseService().transaction((tx) => {
    return completeDirtyMaterializationWithRunner({
      currentNow,
      materializationOwner,
      projectId,
      sourceKind,
      targetDirtyToken,
      tx,
      ...snapshot,
    })
  }) as Promise<ProjectMartDirtyMaterializationStateRecord | null>
}

const materializeProjectScopeDirtyBatch = async ({
  batchSize,
  materializationOwner,
  now,
  projectId,
  sourceKind,
  targetDirtyToken,
  ...snapshot
}: MaterializeProjectScopeDirtyBatchParams): Promise<DirtyMaterializationBatchResult> => {
  const normalizedBatchSize = getNormalizedBatchSize(batchSize)

  if (normalizedBatchSize === 0 || sourceKind !== projectScopeDirtyMaterializationSourceKind) {
    return {insertedRowCountDelta: 0, isComplete: false, materializationState: null}
  }

  const currentNow = getNow(now)

  return getAppDatabaseService().transaction(async (tx) => {
    const materializationState = await getClaimedDirtyMaterializationRecord({
      currentNow,
      materializationOwner,
      projectId,
      sourceKind,
      targetDirtyToken,
      tx,
      ...snapshot,
    })

    if (!materializationState) {
      return {insertedRowCountDelta: 0, isComplete: false, materializationState: null}
    }

    await tx.run('DROP TABLE IF EXISTS temp_project_scope_dirty_materialization_batch')
    await tx.run(`
      CREATE TEMP TABLE temp_project_scope_dirty_materialization_batch AS
      WITH
      ${getProjectScopeDirtyMaterializationSourceSql(projectId)}
      SELECT
        source.project_id,
        source.article_id,
        source.article_created_at
      FROM project_scope_dirty_source source
      WHERE source.project_id = ${getSqlLiteral(projectId)}
        ${getProjectScopeHighWaterPredicateSql(snapshot, 'source.article_created_at', 'source.article_id')}
        ${getProjectScopeCursorPredicateSql(
          {
            cursorArticleCreatedAt: materializationState.cursorArticleCreatedAt,
            cursorArticleId: materializationState.cursorArticleId,
          },
          'source.article_created_at',
          'source.article_id',
        )}
      ORDER BY ${getProjectScopeOrderSql('source.article_created_at', 'source.article_id')}
      LIMIT ${normalizedBatchSize}
    `)

    const [batchStats] = await tx.queryJson<{
      cursorArticleCreatedAt: Date | null
      cursorArticleId: string | null
      insertedRowCountDelta: number
    }>(`
      SELECT
        CAST(COUNT(*) AS INTEGER) AS insertedRowCountDelta,
        (
          SELECT article_created_at
          FROM temp_project_scope_dirty_materialization_batch
          ORDER BY ${getProjectScopeReverseOrderSql('article_created_at', 'article_id')}
          LIMIT 1
        ) AS cursorArticleCreatedAt,
        (
          SELECT article_id
          FROM temp_project_scope_dirty_materialization_batch
          ORDER BY ${getProjectScopeReverseOrderSql('article_created_at', 'article_id')}
          LIMIT 1
        ) AS cursorArticleId
      FROM temp_project_scope_dirty_materialization_batch
    `)
    const insertedRowCountDelta = Number(batchStats?.insertedRowCountDelta ?? 0)

    if (insertedRowCountDelta === 0) {
      const completed = await completeDirtyMaterializationWithRunner({
        currentNow,
        materializationOwner,
        projectId,
        sourceKind,
        targetDirtyToken,
        tx,
        ...snapshot,
      })
      const materializationStateAfterCompletion =
        completed ?? (await getDirtyMaterializationStateRecord(tx, {projectId, sourceKind, targetDirtyToken}))

      await tx.run('DROP TABLE IF EXISTS temp_project_scope_dirty_materialization_batch')

      return {
        insertedRowCountDelta: 0,
        isComplete: completed?.materializationStatus === 'completed',
        materializationState: materializationStateAfterCompletion,
      }
    }

    await tx.run(`
      INSERT INTO app.project_mart_refresh_article_state (
        project_id,
        article_id,
        first_dirty_token,
        last_dirty_token,
        updated_at
      )
      SELECT
        project_id,
        article_id,
        ${targetDirtyToken},
        ${targetDirtyToken},
        ${getTimestampLiteral(currentNow)}
      FROM temp_project_scope_dirty_materialization_batch
      ON CONFLICT(project_id, article_id) DO UPDATE SET
        first_dirty_token = CASE
          WHEN app.project_mart_refresh_article_state.last_dirty_token = 0
          THEN EXCLUDED.first_dirty_token
          ELSE LEAST(app.project_mart_refresh_article_state.first_dirty_token, EXCLUDED.first_dirty_token)
        END,
        last_dirty_token = GREATEST(app.project_mart_refresh_article_state.last_dirty_token, EXCLUDED.last_dirty_token),
        updated_at = EXCLUDED.updated_at
    `)

    const [updated] = await tx.queryJson<ProjectMartDirtyMaterializationStateRecord>(`
      UPDATE app.project_mart_dirty_materialization_state
      SET
        cursor_article_created_at = ${getSqlLiteral(batchStats?.cursorArticleCreatedAt ?? null)},
        cursor_article_id = ${getSqlLiteral(batchStats?.cursorArticleId ?? null)},
        inserted_row_count = inserted_row_count + ${insertedRowCountDelta},
        updated_at = ${getTimestampLiteral(currentNow)}
      WHERE project_id = ${getSqlLiteral(projectId)}
        AND source_kind = ${getSqlLiteral(sourceKind)}
        AND target_dirty_token = ${targetDirtyToken}
        ${getSourceSnapshotFenceSql(snapshot)}
        AND materialization_status = 'running'
        AND materialization_owner = ${getSqlLiteral(materializationOwner)}
        AND lease_expires_at > ${getTimestampLiteral(currentNow)}
      RETURNING *
    `)
    const materializationStateAfterBatch = updated
      ? await getDirtyMaterializationStateRecord(tx, {projectId, sourceKind, targetDirtyToken})
      : null

    await tx.run('DROP TABLE IF EXISTS temp_project_scope_dirty_materialization_batch')

    return {insertedRowCountDelta, isComplete: false, materializationState: materializationStateAfterBatch}
  }) as Promise<DirtyMaterializationBatchResult>
}

const failDirtyMaterialization = async ({
  error,
  materializationOwner,
  now,
  projectId,
  sourceKind,
  targetDirtyToken,
  ...snapshot
}: FailDirtyMaterializationParams) => {
  const currentNow = getNow(now)
  const [row] = await getAppDatabaseService().queryJson<ProjectMartDirtyMaterializationStateRecord>(`
    UPDATE app.project_mart_dirty_materialization_state
    SET
      materialization_status = 'failed',
      materialization_owner = NULL,
      lease_expires_at = NULL,
      last_failed_at = ${getTimestampLiteral(currentNow)},
      last_error = ${getSqlLiteral(error)},
      updated_at = ${getTimestampLiteral(currentNow)}
    WHERE project_id = ${getSqlLiteral(projectId)}
      AND source_kind = ${getSqlLiteral(sourceKind)}
      AND target_dirty_token = ${targetDirtyToken}
      ${getSourceSnapshotFenceSql(snapshot)}
      AND materialization_status = 'running'
      AND materialization_owner = ${getSqlLiteral(materializationOwner)}
      AND lease_expires_at > ${getTimestampLiteral(currentNow)}
    RETURNING *
  `)

  return row
    ? getDirtyMaterializationStateRecord(getAppDatabaseService(), {projectId, sourceKind, targetDirtyToken})
    : null
}

const getCompletedDirtyMaterializationToken = async ({
  projectId,
  sourceKind,
  targetDirtyToken,
  ...snapshot
}: GetCompletedDirtyMaterializationTokenParams) => {
  const [row] = await getAppDatabaseService().queryJson<{targetDirtyToken: number}>(`
    SELECT CAST(target_dirty_token AS INTEGER) AS targetDirtyToken
    FROM app.project_mart_dirty_materialization_state
    WHERE project_id = ${getSqlLiteral(projectId)}
      AND source_kind = ${getSqlLiteral(sourceKind)}
      AND target_dirty_token = ${targetDirtyToken}
      ${getSourceSnapshotFenceSql(snapshot)}
      AND materialization_status = 'completed'
    LIMIT 1
  `)

  return row?.targetDirtyToken ?? null
}

const projectMartDirtyMaterializationService = {
  advanceDirtyMaterializationCursor,
  claimDirtyMaterializations,
  completeDirtyMaterialization,
  failDirtyMaterialization,
  getClaimedDirtyMaterialization,
  getCompletedDirtyMaterializationToken,
  getProjectScopeDirtyMaterializationSnapshot,
  heartbeatDirtyMaterialization,
  materializeProjectScopeDirtyBatch,
  queueDirtyMaterialization,
  requeueDirtyMaterialization,
}

export const getProjectMartDirtyMaterializationService = () => {
  return projectMartDirtyMaterializationService
}

export type {
  AdvanceDirtyMaterializationCursorParams,
  ClaimDirtyMaterializationsParams,
  CompleteDirtyMaterializationParams,
  DirtyMaterializationBatchResult,
  DirtyMaterializationClaim,
  DirtyMaterializationFence,
  DirtyMaterializationSourceSnapshot,
  FailDirtyMaterializationParams,
  GetCompletedDirtyMaterializationTokenParams,
  GetProjectScopeDirtyMaterializationSnapshotParams,
  HeartbeatDirtyMaterializationParams,
  MaterializeProjectScopeDirtyBatchParams,
  ProjectScopeDirtyMaterializationSnapshot,
  QueueDirtyMaterializationParams,
  RequeueDirtyMaterializationParams,
}

export {projectScopeDirtyMaterializationSourceKind}
