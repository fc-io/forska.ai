import type {
  ProjectMartDirtyRefreshArticleQuarantineRecord,
  ProjectMartDirtyRefreshStateRecord,
  ProjectMartRefreshStatus,
} from '../../db/schemaTypes.ts'
import {getAppDatabaseService} from './appDatabaseService.ts'
import {getQuotedStringList, getSqlLiteral, getTimestampLiteral} from './appQueryHelpers.ts'
import {getMaintenanceWorkLeaseService} from './maintenanceWorkLeaseService.ts'
import {
  getProjectMartDirtyMaterializationService,
  projectScopeDirtyMaterializationSourceKind,
} from './projectMartDirtyMaterializationService.ts'

type RefreshStateRunner = {queryJson: <T>(statement: string) => Promise<T[]>; run: (statement: string) => Promise<void>}

type DirtyProjectInput = {articleIds?: string[]; projectId: string}

type MarkProjectsDirtyAtomicallyParams = {
  now?: Date
  projects: DirtyProjectInput[]
  requestedBy?: string | null
  runner?: RefreshStateRunner
  reason?: string | null
}

type MarkArticleProjectsDirtyAtomicallyParams = {
  articleIds: string[]
  now?: Date
  requestedBy?: string | null
  runner?: RefreshStateRunner
  reason?: string | null
}

type MarkedProjectDirtyState = {dirtyToken: number; projectId: string}

type DirtyProjectArticleRow = {articleId: string; projectId: string}

type DirtyProjectIdRow = {projectId: string}

type NormalizedDirtyProject = {articleIds?: string[]; projectId: string}

type ClaimDirtyProjectsParams = {leaseMs: number; limit: number; now?: Date; workerId: string}

type ProjectRefreshClaim = {
  claimedToken: number
  lastCompletedToken: number
  leaseExpiresAt: Date
  projectId: string
  workerId: string
}

type HeartbeatClaimParams = {leaseMs: number; now?: Date; projectId: string; workerId: string}

type GetDirtyArticleBatchForClaimParams = {batchSize: number; claimedToken: number; projectId: string; workerId: string}

type DirtyArticleBatchForClaim = {articleIds: string[]; hasMore: boolean}

type GetDirtyArticlesForClaimParams = {claimedToken: number; lastCompletedToken: number; projectId: string}

type CompleteDirtyArticleBatchForClaimParams = {
  articleIds: string[]
  claimedToken: number
  now?: Date
  projectId: string
  workerId: string
}

type ProjectRefreshBatchCompletion = {
  completedState: ProjectMartDirtyRefreshStateRecord | null
  isBlockedByQuarantine: boolean
  isClaimComplete: boolean
}

type CompleteProjectRefreshParams = {completedToken: number; now?: Date; projectId: string; workerId: string}

type FinalizeProjectRefreshAfterLargeRebuildParams = {completedToken: number; now?: Date; projectId: string}

type ReleaseProjectRefreshClaimParams = {now?: Date; projectId: string; workerId: string}

type ClearProjectRefreshStateParams = {now?: Date; projectId: string; runner?: RefreshStateRunner}

type ClearArchivedProjectRefreshStatesParams = {now?: Date; runner?: RefreshStateRunner}

type QuarantineProjectRefreshArticleParams = {
  articleId: string
  detectedBy?: string | null
  dirtyToken?: number | null
  error: string
  now?: Date
  projectId?: string | null
  runner?: RefreshStateRunner
}

type GetQuarantinedArticlesForProjectParams = {articleIds?: string[]; projectId: string; runner?: RefreshStateRunner}

type ResolveProjectRefreshArticleQuarantineParams = {
  articleId?: string
  dirtyToken?: number
  now?: Date
  projectId: string
  runner?: RefreshStateRunner
}

type CleanupResolvedProjectRefreshArticleQuarantinesParams = {limit: number; runner?: RefreshStateRunner}

type FailProjectRefreshParams = {error: string; now?: Date; projectId: string; workerId: string}

type ProjectRefreshStateRow = {
  activeDirtyToken: number
  dirtyToken: number
  lastCompletedDirtyToken: number
  projectId: string
  refreshStatus: ProjectMartRefreshStatus
  workerId: string | null
}

type DirtyTokenBarrierKind = 'dirty_article' | 'materialization' | 'quarantine'

type DirtyTokenCompletionBarrier = {barrierKind: DirtyTokenBarrierKind; barrierToken: number} | null

type CompletedThroughDirtyTokenParams = {completedToken: number; projectId: string; tx: RefreshStateRunner}

const dirtyRefreshArticleInputTableName = 'temp_project_mart_dirty_refresh_article_input'
const dirtyRefreshArticleInputBatchSize = 1_000

const getNow = (value?: Date) => {
  return value ?? new Date()
}

const getLeaseExpiry = (now: Date, leaseMs: number) => {
  return new Date(now.getTime() + leaseMs)
}

const getUniqueValues = (values: string[]) => {
  return Array.from(new Set(values))
}

const getValueChunks = <TValue>(values: TValue[], chunkSize = dirtyRefreshArticleInputBatchSize): TValue[][] => {
  return values.length === 0
    ? []
    : values.length <= chunkSize
      ? [values]
      : [values.slice(0, chunkSize), ...getValueChunks(values.slice(chunkSize), chunkSize)]
}

const createDirtyRefreshArticleInputTable = async (runner: RefreshStateRunner, articleIds: string[]) => {
  await runner.run(`
    DROP TABLE IF EXISTS ${dirtyRefreshArticleInputTableName};
    CREATE TEMP TABLE ${dirtyRefreshArticleInputTableName} (article_id VARCHAR);
  `)

  await getValueChunks(articleIds).reduce<Promise<void>>((previousRun, articleIdChunk) => {
    return previousRun.then(() => {
      return runner.run(`
        INSERT INTO ${dirtyRefreshArticleInputTableName} (article_id)
        SELECT DISTINCT article_id
        FROM UNNEST(${getSqlLiteral(articleIdChunk)}) AS article_input(article_id)
        WHERE article_id IS NOT NULL;
      `)
    })
  }, Promise.resolve())
}

const dropDirtyRefreshArticleInputTable = async (runner: RefreshStateRunner) => {
  await runner.run(`
    DROP TABLE IF EXISTS ${dirtyRefreshArticleInputTableName}
  `)
}

const getDirtyRefreshArticleInputExistsSql = (articleIdColumn: string) => {
  return `EXISTS (
        SELECT 1
        FROM ${dirtyRefreshArticleInputTableName} article_input
        WHERE article_input.article_id = ${articleIdColumn}
      )`
}

const getNormalizedBatchSize = (batchSize: number) => {
  return Math.max(0, Math.floor(batchSize))
}

const normalizeDirtyProjects = (projects: DirtyProjectInput[]) => {
  return projects.reduce((acc, project) => {
    const existing = acc.get(project.projectId)
    const articleIds = project.articleIds === undefined ? undefined : getUniqueValues(project.articleIds)
    const normalizedArticleIds =
      articleIds === undefined || (existing !== undefined && existing.articleIds === undefined)
        ? undefined
        : getUniqueValues([...(existing?.articleIds ?? []), ...articleIds])

    acc.set(project.projectId, {articleIds: normalizedArticleIds, projectId: project.projectId})

    return acc
  }, new Map<string, NormalizedDirtyProject>())
}

const ensureProjectRefreshStateRow = async (runner: RefreshStateRunner, projectId: string) => {
  await runner.run(`
    INSERT INTO app.project_mart_refresh_state (project_id)
    VALUES (${getSqlLiteral(projectId)})
    ON CONFLICT(project_id) DO NOTHING
  `)
}

const getProjectRefreshArticleQuarantineRecord = async (
  runner: RefreshStateRunner,
  params: {articleId: string; dirtyToken: number; projectId: string},
) => {
  const [row] = await runner.queryJson<ProjectMartDirtyRefreshArticleQuarantineRecord>(`
    SELECT
      project_id AS projectId,
      article_id AS articleId,
      CAST(dirty_token AS INTEGER) AS dirtyToken,
      error,
      detected_by AS detectedBy,
      resolved_at AS resolvedAt,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM app.project_mart_dirty_refresh_article_quarantine
    WHERE project_id = ${getSqlLiteral(params.projectId)}
      AND article_id = ${getSqlLiteral(params.articleId)}
      AND dirty_token = ${params.dirtyToken}
    LIMIT 1
  `)

  return row ?? null
}

const markSingleProjectDirty = async (
  runner: RefreshStateRunner,
  project: NormalizedDirtyProject,
  params: {now: Date; requestedBy: string | null; reason: string | null},
): Promise<MarkedProjectDirtyState> => {
  await ensureProjectRefreshStateRow(runner, project.projectId)

  const [state] = await runner.queryJson<MarkedProjectDirtyState>(`
    UPDATE app.project_mart_refresh_state
    SET
      dirty_token = dirty_token + 1,
      last_requested_at = ${getTimestampLiteral(params.now)},
      last_request_reason = ${getSqlLiteral(params.reason)},
      requested_by = ${getSqlLiteral(params.requestedBy)},
      updated_at = ${getTimestampLiteral(params.now)}
    WHERE project_id = ${getSqlLiteral(project.projectId)}
    RETURNING
      project_id AS projectId,
      CAST(dirty_token AS INTEGER) AS dirtyToken
  `)

  if (!state) {
    throw new Error(`Failed to mark project refresh state dirty for ${project.projectId}`)
  }

  if (project.articleIds === undefined) {
    const sourceSnapshot =
      await getProjectMartDirtyMaterializationService().getProjectScopeDirtyMaterializationSnapshot({
        projectId: project.projectId,
        runner,
      })

    await getProjectMartDirtyMaterializationService().queueDirtyMaterialization({
      projectId: project.projectId,
      runner,
      sourceKind: projectScopeDirtyMaterializationSourceKind,
      targetDirtyToken: state.dirtyToken,
      ...sourceSnapshot,
      now: params.now,
    })

    if (sourceSnapshot.sourceScopeExpectedRowCount === 0) {
      await runner.run(`
        UPDATE app.project_mart_dirty_materialization_state
        SET
          materialization_status = 'completed',
          last_completed_at = ${getTimestampLiteral(params.now)},
          updated_at = ${getTimestampLiteral(params.now)}
        WHERE project_id = ${getSqlLiteral(project.projectId)}
          AND source_kind = ${getSqlLiteral(projectScopeDirtyMaterializationSourceKind)}
          AND target_dirty_token = ${state.dirtyToken}
      `)
    }
  }

  if (project.articleIds !== undefined && project.articleIds.length > 0) {
    await createDirtyRefreshArticleInputTable(runner, project.articleIds)
    await runner.run(`
      INSERT INTO app.project_mart_refresh_article_state (
        project_id,
        article_id,
        first_dirty_token,
        last_dirty_token,
        updated_at
      )
      SELECT
        ${getSqlLiteral(project.projectId)},
        article_input.article_id,
        ${state.dirtyToken},
        ${state.dirtyToken},
        ${getTimestampLiteral(params.now)}
      FROM ${dirtyRefreshArticleInputTableName} article_input
      ON CONFLICT(project_id, article_id) DO UPDATE SET
        first_dirty_token = LEAST(app.project_mart_refresh_article_state.first_dirty_token, EXCLUDED.first_dirty_token),
        last_dirty_token = GREATEST(app.project_mart_refresh_article_state.last_dirty_token, EXCLUDED.last_dirty_token),
        updated_at = EXCLUDED.updated_at
    `)
    await dropDirtyRefreshArticleInputTable(runner)
  }

  return state
}

const withTransaction = async <T>(
  runner: RefreshStateRunner | undefined,
  work: (tx: RefreshStateRunner) => Promise<T>,
): Promise<T> => {
  return runner ? work(runner) : (getAppDatabaseService().transaction(work) as Promise<T>)
}

const getProjectRefreshStateRecord = async (runner: RefreshStateRunner, projectId: string) => {
  const [row] = await runner.queryJson<ProjectMartDirtyRefreshStateRecord>(`
    SELECT
      project_id AS projectId,
      CAST(dirty_token AS INTEGER) AS dirtyToken,
      CAST(active_dirty_token AS INTEGER) AS activeDirtyToken,
      CAST(last_completed_dirty_token AS INTEGER) AS lastCompletedDirtyToken,
      last_requested_at AS lastRequestedAt,
      last_request_reason AS lastRequestReason,
      requested_by AS requestedBy,
      refresh_status AS refreshStatus,
      last_started_at AS lastStartedAt,
      last_completed_at AS lastCompletedAt,
      last_failed_at AS lastFailedAt,
      last_error AS lastError,
      worker_id AS workerId,
      lease_expires_at AS leaseExpiresAt,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM app.project_mart_refresh_state
    WHERE project_id = ${getSqlLiteral(projectId)}
    LIMIT 1
  `)

  return row ?? null
}

const getDirtyProjectsForArticleIds = async (runner: RefreshStateRunner, articleIds: string[]) => {
  const uniqueArticleIds = getUniqueValues(articleIds)

  if (uniqueArticleIds.length === 0) {
    return []
  }

  await createDirtyRefreshArticleInputTable(runner, uniqueArticleIds)
  const rows = await runner.queryJson<DirtyProjectArticleRow>(`
    SELECT projectId, articleId
    FROM (
      SELECT
        project_article.project_id AS projectId,
        project_article.article_id AS articleId
      FROM app.project_article project_article
      INNER JOIN app.project project ON project.id = project_article.project_id
      WHERE ${getDirtyRefreshArticleInputExistsSql('project_article.article_id')}
        AND project.archived = FALSE
      UNION
      SELECT
        project_import_route.project_id AS projectId,
        article_import_route.article_id AS articleId
      FROM app.article_import_route article_import_route
      INNER JOIN app.project_import_route project_import_route
        ON project_import_route.import_route_id = article_import_route.import_route_id
      INNER JOIN app.project project ON project.id = project_import_route.project_id
      WHERE ${getDirtyRefreshArticleInputExistsSql('article_import_route.article_id')}
        AND project.archived = FALSE
    ) resolved_projects
    ORDER BY projectId ASC, articleId ASC
  `)
  await dropDirtyRefreshArticleInputTable(runner)

  return Array.from(
    rows
      .reduce((acc, row) => {
        const existing = acc.get(row.projectId)

        acc.set(row.projectId, {
          articleIds: getUniqueValues([...(existing?.articleIds ?? []), row.articleId]),
          projectId: row.projectId,
        })

        return acc
      }, new Map<string, {articleIds: string[]; projectId: string}>())
      .values(),
  )
}

const getDirtyProjectsForProjectIds = async (runner: RefreshStateRunner, projectIds: string[]) => {
  const uniqueProjectIds = getUniqueValues(projectIds)

  if (uniqueProjectIds.length === 0) {
    return []
  }

  return runner.queryJson<DirtyProjectIdRow>(`
    SELECT id AS projectId
    FROM app.project
    WHERE id IN (${getQuotedStringList(uniqueProjectIds).join(', ')})
      AND archived = FALSE
    ORDER BY id ASC
  `)
}

const markProjectsDirtyAtomically = async ({
  now,
  projects,
  requestedBy = null,
  runner,
  reason = null,
}: MarkProjectsDirtyAtomicallyParams): Promise<MarkedProjectDirtyState[]> => {
  const normalizedProjects = Array.from(normalizeDirtyProjects(projects).values())

  return normalizedProjects.length === 0
    ? []
    : await withTransaction(runner, async (tx) => {
        const currentNow = getNow(now)

        return normalizedProjects.reduce<Promise<MarkedProjectDirtyState[]>>(async (accPromise, project) => {
          const acc = await accPromise
          const state = await markSingleProjectDirty(tx, project, {now: currentNow, requestedBy, reason})
          return [...acc, state]
        }, Promise.resolve([]))
      })
}

const markArticleProjectsDirtyAtomically = async ({
  articleIds,
  now,
  requestedBy = null,
  runner,
  reason = null,
}: MarkArticleProjectsDirtyAtomicallyParams): Promise<MarkedProjectDirtyState[]> => {
  return articleIds.length === 0
    ? []
    : withTransaction(runner, async (tx) => {
        const projects = await getDirtyProjectsForArticleIds(tx, articleIds)

        return markProjectsDirtyAtomically({now, projects, requestedBy, runner: tx, reason})
      })
}

const claimDirtyProjects = async ({
  leaseMs,
  limit,
  now,
  workerId,
}: ClaimDirtyProjectsParams): Promise<ProjectRefreshClaim[]> => {
  if (limit <= 0) {
    return []
  }

  const currentNow = getNow(now)
  const leaseExpiresAt = getLeaseExpiry(currentNow, leaseMs)
  const claimableRows = await getAppDatabaseService().queryJson<{
    dirtyToken: number
    lastCompletedToken: number
    projectId: string
  }>(`
    SELECT
      state.project_id AS projectId,
      CAST(state.dirty_token AS INTEGER) AS dirtyToken,
      CAST(state.last_completed_dirty_token AS INTEGER) AS lastCompletedToken
    FROM app.project_mart_refresh_state state
    INNER JOIN app.project project ON project.id = state.project_id
    WHERE project.archived = FALSE
      AND state.dirty_token > state.last_completed_dirty_token
      AND NOT EXISTS (
        SELECT 1
        FROM app.project_mart_large_rebuild_state large_rebuild
        WHERE large_rebuild.project_id = state.project_id
          AND large_rebuild.refresh_token >= state.dirty_token
      )
      AND NOT EXISTS (
        SELECT 1
        FROM app.project_mart_dirty_materialization_state materialization
        WHERE materialization.project_id = state.project_id
          AND materialization.target_dirty_token <= state.dirty_token
          AND materialization.materialization_status <> 'completed'
      )
      AND (
        state.refresh_status <> 'running'
        OR state.lease_expires_at IS NULL
        OR state.lease_expires_at <= ${getTimestampLiteral(currentNow)}
      )
      AND (
        state.refresh_status <> 'blocked_by_quarantine'
        OR state.dirty_token > state.active_dirty_token
        OR NOT EXISTS (
          SELECT 1
          FROM app.project_mart_dirty_refresh_article_quarantine quarantine
          WHERE quarantine.project_id = state.project_id
            AND quarantine.dirty_token <= state.dirty_token
            AND quarantine.resolved_at IS NULL
        )
      )
    ORDER BY state.last_requested_at ASC, state.project_id ASC
    LIMIT ${Math.max(0, Math.floor(limit))}
  `)

  return claimableRows.reduce<Promise<ProjectRefreshClaim[]>>(async (accPromise, row) => {
    const acc = await accPromise
    const [claimed] = await getAppDatabaseService().queryJson<ProjectRefreshClaim>(`
      UPDATE app.project_mart_refresh_state
      SET
        active_dirty_token=${row.dirtyToken},
        refresh_status = 'running',
        last_started_at = ${getTimestampLiteral(currentNow)},
        last_error = NULL,
        worker_id = ${getSqlLiteral(workerId)},
        lease_expires_at = ${getTimestampLiteral(leaseExpiresAt)},
        updated_at = ${getTimestampLiteral(currentNow)}
      WHERE project_id = ${getSqlLiteral(row.projectId)}
        AND dirty_token > last_completed_dirty_token
        AND NOT EXISTS (
        SELECT 1
        FROM app.project_mart_dirty_materialization_state materialization
        WHERE materialization.project_id = app.project_mart_refresh_state.project_id
            AND materialization.target_dirty_token <= app.project_mart_refresh_state.dirty_token
            AND materialization.materialization_status <> 'completed'
        )
        AND (
          refresh_status <> 'running'
          OR lease_expires_at IS NULL
          OR lease_expires_at <= ${getTimestampLiteral(currentNow)}
        )
        AND (
          refresh_status <> 'blocked_by_quarantine'
          OR dirty_token > active_dirty_token
          OR NOT EXISTS (
            SELECT 1
            FROM app.project_mart_dirty_refresh_article_quarantine quarantine
            WHERE quarantine.project_id = app.project_mart_refresh_state.project_id
              AND quarantine.dirty_token <= app.project_mart_refresh_state.dirty_token
              AND quarantine.resolved_at IS NULL
          )
        )
      RETURNING
        project_id AS projectId,
        ${getSqlLiteral(workerId)} AS workerId,
        CAST(active_dirty_token AS INTEGER) AS claimedToken,
        CAST(last_completed_dirty_token AS INTEGER) AS lastCompletedToken,
        lease_expires_at AS leaseExpiresAt
    `)

    if (!claimed) {
      return acc
    }

    await getMaintenanceWorkLeaseService().claimMaintenanceWorkLease({
      consumerId: workerId,
      leaseMs,
      now: currentNow,
      projectId: claimed.projectId,
      requiredConsumerRole: 'maintenance-worker',
      scopeKind: 'project',
      workKind: 'review_index_project_refresh',
    })

    return [...acc, claimed]
  }, Promise.resolve([]))
}

const heartbeatClaim = async ({
  leaseMs,
  now,
  projectId,
  workerId,
}: HeartbeatClaimParams): Promise<ProjectRefreshClaim | null> => {
  const currentNow = getNow(now)
  const leaseExpiresAt = getLeaseExpiry(currentNow, leaseMs)
  const [claim] = await getAppDatabaseService().queryJson<ProjectRefreshClaim>(`
    UPDATE app.project_mart_refresh_state
    SET
      lease_expires_at = ${getTimestampLiteral(leaseExpiresAt)},
      updated_at = ${getTimestampLiteral(currentNow)}
    WHERE project_id = ${getSqlLiteral(projectId)}
      AND worker_id = ${getSqlLiteral(workerId)}
      AND refresh_status = 'running'
    RETURNING
      project_id AS projectId,
      worker_id AS workerId,
      CAST(active_dirty_token AS INTEGER) AS claimedToken,
      CAST(last_completed_dirty_token AS INTEGER) AS lastCompletedToken,
      lease_expires_at AS leaseExpiresAt
  `)

  if (claim) {
    await getMaintenanceWorkLeaseService().progressMaintenanceWorkLease({
      consumerId: workerId,
      leaseMs,
      now: currentNow,
      projectId,
      requiredConsumerRole: 'maintenance-worker',
      scopeKind: 'project',
      workKind: 'review_index_project_refresh',
    })
  }

  return claim ?? null
}

const getDirtyArticlesForClaim = async ({
  claimedToken,
  lastCompletedToken,
  projectId,
}: GetDirtyArticlesForClaimParams) => {
  return getAppDatabaseService().queryJson<{articleId: string}>(`
    SELECT article_id AS articleId
    FROM app.project_mart_refresh_article_state
    WHERE project_id = ${getSqlLiteral(projectId)}
      AND first_dirty_token <= ${claimedToken}
      AND last_dirty_token > ${lastCompletedToken}
    ORDER BY article_id ASC
  `)
}

const getDirtyArticleBatchForClaim = async ({
  batchSize,
  claimedToken,
  projectId,
  workerId,
}: GetDirtyArticleBatchForClaimParams): Promise<DirtyArticleBatchForClaim> => {
  const normalizedBatchSize = getNormalizedBatchSize(batchSize)

  if (normalizedBatchSize === 0) {
    return {articleIds: [], hasMore: false}
  }

  const rows = await getAppDatabaseService().queryJson<{articleId: string}>(`
    SELECT article_state.article_id AS articleId
    FROM app.project_mart_refresh_state state
    INNER JOIN app.project_mart_refresh_article_state article_state
      ON article_state.project_id = state.project_id
    LEFT JOIN app.project_mart_dirty_refresh_article_quarantine quarantine
      ON quarantine.project_id = article_state.project_id
      AND quarantine.article_id = article_state.article_id
      AND quarantine.dirty_token <= state.active_dirty_token
      AND quarantine.resolved_at IS NULL
    WHERE state.project_id = ${getSqlLiteral(projectId)}
      AND state.worker_id = ${getSqlLiteral(workerId)}
      AND state.refresh_status = 'running'
      AND state.active_dirty_token = ${claimedToken}
      AND article_state.first_dirty_token <= state.active_dirty_token
      AND article_state.last_dirty_token > state.last_completed_dirty_token
      AND quarantine.project_id IS NULL
    ORDER BY article_state.article_id ASC
    LIMIT ${normalizedBatchSize + 1}
  `)

  return {
    articleIds: rows.slice(0, normalizedBatchSize).map((row) => {
      return row.articleId
    }),
    hasMore: rows.length > normalizedBatchSize,
  }
}

const releaseProjectRefreshClaim = async ({now, projectId, workerId}: ReleaseProjectRefreshClaimParams) => {
  const currentNow = getNow(now)
  const [released] = await getAppDatabaseService().queryJson<ProjectRefreshStateRow>(`
    UPDATE app.project_mart_refresh_state
    SET
      active_dirty_token=0,
      refresh_status = 'idle',
      worker_id = NULL,
      lease_expires_at = NULL,
      updated_at = ${getTimestampLiteral(currentNow)}
    WHERE project_id = ${getSqlLiteral(projectId)}
      AND worker_id = ${getSqlLiteral(workerId)}
      AND refresh_status = 'running'
    RETURNING
      project_id AS projectId,
      CAST(dirty_token AS INTEGER) AS dirtyToken,
      CAST(active_dirty_token AS INTEGER) AS activeDirtyToken,
      CAST(last_completed_dirty_token AS INTEGER) AS lastCompletedDirtyToken,
      refresh_status AS refreshStatus,
      worker_id AS workerId
  `)

  if (released) {
    await getMaintenanceWorkLeaseService().completeMaintenanceWorkLease({
      consumerId: workerId,
      now: currentNow,
      projectId,
      scopeKind: 'project',
      workKind: 'review_index_project_refresh',
    })
  }

  return released ? getProjectRefreshStateRecord(getAppDatabaseService(), projectId) : null
}

const clearProjectRefreshState = async ({now: _now, projectId, runner}: ClearProjectRefreshStateParams) => {
  return withTransaction(runner, async (tx) => {
    await tx.run(`
      DELETE FROM app.project_mart_dirty_refresh_article_quarantine
      WHERE project_id = ${getSqlLiteral(projectId)}
    `)
    await tx.run(`
      DELETE FROM app.project_mart_refresh_article_state
      WHERE project_id = ${getSqlLiteral(projectId)}
    `)
    await tx.run(`
      DELETE FROM app.project_mart_refresh_state
      WHERE project_id = ${getSqlLiteral(projectId)}
    `)

    return getProjectRefreshStateRecord(tx, projectId)
  })
}

const clearArchivedProjectRefreshStates = async ({runner}: ClearArchivedProjectRefreshStatesParams = {}) => {
  return withTransaction(runner, async (tx) => {
    await tx.run(`
      DELETE FROM app.project_mart_dirty_refresh_article_quarantine
      WHERE project_id IN (
        SELECT id
        FROM app.project
        WHERE archived = TRUE
      )
    `)
    await tx.run(`
      DELETE FROM app.project_mart_refresh_article_state
      WHERE project_id IN (
        SELECT id
        FROM app.project
        WHERE archived = TRUE
      )
    `)
    await tx.run(`
      DELETE FROM app.project_mart_refresh_state
      WHERE project_id IN (
        SELECT id
        FROM app.project
        WHERE archived = TRUE
      )
    `)
  })
}

const getQuarantinedArticlesForProject = async ({
  articleIds,
  projectId,
  runner,
}: GetQuarantinedArticlesForProjectParams) => {
  const activeRunner = runner ?? getAppDatabaseService()
  const uniqueArticleIds = articleIds && articleIds.length > 0 ? getUniqueValues(articleIds) : []
  const idsFilter =
    uniqueArticleIds.length > 0 ? `AND ${getDirtyRefreshArticleInputExistsSql('quarantine.article_id')}` : ''

  if (uniqueArticleIds.length > 0) {
    await createDirtyRefreshArticleInputTable(activeRunner, uniqueArticleIds)
  }

  const rows = await activeRunner.queryJson<ProjectMartDirtyRefreshArticleQuarantineRecord>(`
    SELECT
      quarantine.project_id AS projectId,
      quarantine.article_id AS articleId,
      CAST(quarantine.dirty_token AS INTEGER) AS dirtyToken,
      quarantine.error,
      quarantine.detected_by AS detectedBy,
      quarantine.resolved_at AS resolvedAt,
      quarantine.created_at AS createdAt,
      quarantine.updated_at AS updatedAt
    FROM app.project_mart_dirty_refresh_article_quarantine quarantine
    WHERE quarantine.project_id = ${getSqlLiteral(projectId)}
      AND quarantine.resolved_at IS NULL
      ${idsFilter}
    ORDER BY quarantine.dirty_token ASC, quarantine.article_id ASC
  `)

  if (uniqueArticleIds.length > 0) {
    await dropDirtyRefreshArticleInputTable(activeRunner)
  }

  return rows
}

const quarantineProjectRefreshArticle = async ({
  articleId,
  detectedBy = null,
  dirtyToken = null,
  error,
  now,
  projectId = null,
  runner,
}: QuarantineProjectRefreshArticleParams) => {
  return withTransaction(runner, async (tx) => {
    const currentNow = getNow(now)
    const projectFilter = projectId === null ? '' : `AND article_state.project_id = ${getSqlLiteral(projectId)}`
    const dirtyTokenSql =
      dirtyToken === null
        ? 'GREATEST(article_state.first_dirty_token, refresh_state.last_completed_dirty_token + 1, 1)'
        : String(dirtyToken)
    const dirtyTokenFilter =
      dirtyToken === null
        ? 'AND article_state.last_dirty_token > refresh_state.last_completed_dirty_token'
        : `AND article_state.first_dirty_token <= ${dirtyToken} AND article_state.last_dirty_token >= ${dirtyToken}`
    const candidates = await tx.queryJson<{dirtyToken: number; projectId: string}>(`
      SELECT
        article_state.project_id AS projectId,
        CAST(${dirtyTokenSql} AS INTEGER) AS dirtyToken
      FROM app.project_mart_refresh_article_state article_state
      INNER JOIN app.project_mart_refresh_state refresh_state
        ON refresh_state.project_id = article_state.project_id
      WHERE article_state.article_id = ${getSqlLiteral(articleId)}
        ${projectFilter}
        ${dirtyTokenFilter}
      ORDER BY article_state.project_id ASC
    `)

    return candidates.reduce<Promise<ProjectMartDirtyRefreshArticleQuarantineRecord | null>>(
      async (accPromise, candidate) => {
        const acc = await accPromise
        await tx.run(`
        INSERT INTO app.project_mart_dirty_refresh_article_quarantine (
          project_id,
          article_id,
          dirty_token,
          error,
          detected_by,
          resolved_at,
          created_at,
          updated_at
        ) VALUES (
          ${getSqlLiteral(candidate.projectId)},
          ${getSqlLiteral(articleId)},
          ${candidate.dirtyToken},
          ${getSqlLiteral(error)},
          ${getSqlLiteral(detectedBy)},
          NULL,
          ${getTimestampLiteral(currentNow)},
          ${getTimestampLiteral(currentNow)}
        )
        ON CONFLICT(project_id, article_id, dirty_token) DO UPDATE SET
          error = EXCLUDED.error,
          detected_by = EXCLUDED.detected_by,
          resolved_at = NULL,
          updated_at = EXCLUDED.updated_at
      `)
        const record = await getProjectRefreshArticleQuarantineRecord(tx, {
          articleId,
          dirtyToken: candidate.dirtyToken,
          projectId: candidate.projectId,
        })

        return acc ?? record
      },
      Promise.resolve(null),
    )
  })
}

const resolveProjectRefreshArticleQuarantine = async ({
  articleId,
  dirtyToken,
  now,
  projectId,
  runner,
}: ResolveProjectRefreshArticleQuarantineParams) => {
  return withTransaction(runner, async (tx) => {
    const currentNow = getNow(now)
    const articleFilter = articleId === undefined ? '' : `AND article_id = ${getSqlLiteral(articleId)}`
    const dirtyTokenFilter = dirtyToken === undefined ? '' : `AND dirty_token = ${dirtyToken}`

    await tx.run(`
      UPDATE app.project_mart_dirty_refresh_article_quarantine
      SET
        resolved_at = ${getTimestampLiteral(currentNow)},
        updated_at = ${getTimestampLiteral(currentNow)}
      WHERE project_id = ${getSqlLiteral(projectId)}
        AND resolved_at IS NULL
        ${articleFilter}
        ${dirtyTokenFilter}
    `)

    return getQuarantinedArticlesForProject({projectId, runner: tx})
  })
}

const cleanupResolvedProjectRefreshArticleQuarantines = async ({
  limit,
  runner,
}: CleanupResolvedProjectRefreshArticleQuarantinesParams) => {
  const normalizedLimit = Math.max(0, Math.floor(limit))

  if (normalizedLimit === 0) {
    return 0
  }

  return withTransaction(runner, async (tx) => {
    const rows = await tx.queryJson<{articleId: string; dirtyToken: number; projectId: string}>(`
      SELECT
        quarantine.project_id AS projectId,
        quarantine.article_id AS articleId,
        CAST(quarantine.dirty_token AS INTEGER) AS dirtyToken
      FROM app.project_mart_dirty_refresh_article_quarantine quarantine
      INNER JOIN app.project_mart_refresh_state refresh_state
        ON refresh_state.project_id = quarantine.project_id
      WHERE quarantine.resolved_at IS NOT NULL
        AND refresh_state.last_completed_dirty_token >= quarantine.dirty_token
      ORDER BY quarantine.resolved_at ASC, quarantine.project_id ASC, quarantine.article_id ASC, quarantine.dirty_token ASC
      LIMIT ${normalizedLimit}
    `)

    if (rows.length === 0) {
      return 0
    }

    await tx.run(`
      DELETE FROM app.project_mart_dirty_refresh_article_quarantine
      WHERE ${rows
        .map((row) => {
          return `(project_id = ${getSqlLiteral(row.projectId)} AND article_id = ${getSqlLiteral(row.articleId)} AND dirty_token = ${row.dirtyToken})`
        })
        .join(' OR ')}
    `)

    return rows.length
  })
}

const cleanupCompletedProjectRefreshArticleState = async ({
  completedToken,
  currentNow,
  projectId,
  tx,
}: {
  completedToken: number
  currentNow: Date
  projectId: string
  tx: RefreshStateRunner
}) => {
  await tx.run(`
    DELETE FROM app.project_mart_refresh_article_state
    WHERE project_id = ${getSqlLiteral(projectId)}
      AND last_dirty_token <= ${completedToken}
      AND NOT EXISTS (
        SELECT 1
        FROM app.project_mart_dirty_refresh_article_quarantine quarantine
        WHERE quarantine.project_id = app.project_mart_refresh_article_state.project_id
          AND quarantine.article_id = app.project_mart_refresh_article_state.article_id
          AND quarantine.dirty_token <= ${completedToken}
          AND quarantine.resolved_at IS NULL
      )
  `)
  await tx.run(`
    UPDATE app.project_mart_refresh_article_state
    SET
      first_dirty_token = GREATEST(first_dirty_token, ${completedToken + 1}),
      updated_at = ${getTimestampLiteral(currentNow)}
    WHERE project_id = ${getSqlLiteral(projectId)}
      AND first_dirty_token <= ${completedToken}
      AND last_dirty_token > ${completedToken}
      AND NOT EXISTS (
        SELECT 1
        FROM app.project_mart_dirty_refresh_article_quarantine quarantine
        WHERE quarantine.project_id = app.project_mart_refresh_article_state.project_id
          AND quarantine.article_id = app.project_mart_refresh_article_state.article_id
          AND quarantine.dirty_token <= ${completedToken}
          AND quarantine.resolved_at IS NULL
      )
  `)
}

const getDirtyTokenCompletionBarrier = async ({completedToken, projectId, tx}: CompletedThroughDirtyTokenParams) => {
  const [barrier] = await tx.queryJson<{barrierKind: DirtyTokenBarrierKind; barrierToken: number | null}>(`
    WITH dirty_token_barriers AS (
      SELECT
        CAST(target_dirty_token AS INTEGER) AS barrierToken,
        ${getSqlLiteral('materialization')} AS barrierKind
      FROM app.project_mart_dirty_materialization_state
      WHERE project_id = ${getSqlLiteral(projectId)}
        AND target_dirty_token <= ${completedToken}
        AND materialization_status <> 'completed'
      UNION ALL
      SELECT
        CAST(dirty_token AS INTEGER) AS barrierToken,
        ${getSqlLiteral('quarantine')} AS barrierKind
      FROM app.project_mart_dirty_refresh_article_quarantine
      WHERE project_id = ${getSqlLiteral(projectId)}
        AND dirty_token <= ${completedToken}
        AND resolved_at IS NULL
      UNION ALL
      SELECT
        CAST(GREATEST(article_state.first_dirty_token, 1) AS INTEGER) AS barrierToken,
        ${getSqlLiteral('dirty_article')} AS barrierKind
      FROM app.project_mart_refresh_article_state article_state
      WHERE article_state.project_id = ${getSqlLiteral(projectId)}
        AND article_state.last_dirty_token > 0
        AND article_state.first_dirty_token <= ${completedToken}
        AND NOT EXISTS (
          SELECT 1
          FROM app.project_mart_dirty_refresh_article_quarantine quarantine
          WHERE quarantine.project_id = article_state.project_id
            AND quarantine.article_id = article_state.article_id
            AND quarantine.dirty_token <= ${completedToken}
            AND quarantine.resolved_at IS NULL
        )
    )
    SELECT
      barrierKind,
      CAST(barrierToken AS INTEGER) AS barrierToken
    FROM dirty_token_barriers
    ORDER BY barrierToken ASC
    LIMIT 1
  `)

  return barrier?.barrierToken == null
    ? null
    : ({
        barrierKind: barrier.barrierKind,
        barrierToken: Number(barrier.barrierToken),
      } satisfies DirtyTokenCompletionBarrier)
}

const getCompletedThroughDirtyToken = async ({completedToken, projectId, tx}: CompletedThroughDirtyTokenParams) => {
  const [state] = await tx.queryJson<{lastCompletedDirtyToken: number}>(`
    SELECT CAST(last_completed_dirty_token AS INTEGER) AS lastCompletedDirtyToken
    FROM app.project_mart_refresh_state
    WHERE project_id = ${getSqlLiteral(projectId)}
    LIMIT 1
  `)
  const lastCompletedDirtyToken = Number(state?.lastCompletedDirtyToken ?? 0)

  if (completedToken <= lastCompletedDirtyToken) {
    return lastCompletedDirtyToken
  }

  const barrier = await getDirtyTokenCompletionBarrier({completedToken, projectId, tx})
  const barrierToken = barrier?.barrierToken ?? null

  return barrierToken === null ? completedToken : Math.max(lastCompletedDirtyToken, barrierToken - 1)
}

const completeRunningProjectRefreshState = async ({
  completedToken,
  currentNow,
  projectId,
  tx,
  workerId,
}: {
  completedToken: number
  currentNow: Date
  projectId: string
  tx: RefreshStateRunner
  workerId: string
}): Promise<ProjectRefreshBatchCompletion> => {
  const [claimState] = await tx.queryJson<ProjectRefreshStateRow>(`
    SELECT
      project_id AS projectId,
      CAST(dirty_token AS INTEGER) AS dirtyToken,
      CAST(active_dirty_token AS INTEGER) AS activeDirtyToken,
      CAST(last_completed_dirty_token AS INTEGER) AS lastCompletedDirtyToken,
      refresh_status AS refreshStatus,
      worker_id AS workerId
    FROM app.project_mart_refresh_state
    WHERE project_id = ${getSqlLiteral(projectId)}
      AND worker_id = ${getSqlLiteral(workerId)}
      AND refresh_status = 'running'
      AND active_dirty_token = ${completedToken}
    LIMIT 1
  `)

  if (!claimState) {
    return {completedState: null, isBlockedByQuarantine: false, isClaimComplete: false}
  }

  await cleanupCompletedProjectRefreshArticleState({completedToken, currentNow, projectId, tx})

  const completionBarrier = await getDirtyTokenCompletionBarrier({completedToken, projectId, tx})
  const completedThroughToken = await getCompletedThroughDirtyToken({completedToken, projectId, tx})
  const isCompletedThroughClaim = completedThroughToken >= completedToken
  const isBlockedByQuarantine = !isCompletedThroughClaim && completionBarrier?.barrierKind === 'quarantine'
  const isClaimFinished = isCompletedThroughClaim || isBlockedByQuarantine
  const [completed] = await tx.queryJson<ProjectRefreshStateRow>(`
    UPDATE app.project_mart_refresh_state
    SET
      active_dirty_token = CASE
        WHEN ${getSqlLiteral(isCompletedThroughClaim)} THEN 0
        WHEN ${getSqlLiteral(isBlockedByQuarantine)} THEN ${completedToken}
        ELSE active_dirty_token
      END,
      last_completed_dirty_token = GREATEST(last_completed_dirty_token, ${completedThroughToken}),
      refresh_status = CASE
        WHEN ${getSqlLiteral(isCompletedThroughClaim)} THEN 'idle'
        WHEN ${getSqlLiteral(isBlockedByQuarantine)} THEN 'blocked_by_quarantine'
        ELSE refresh_status
      END,
      last_completed_at = CASE
        WHEN ${completedThroughToken} > last_completed_dirty_token THEN ${getTimestampLiteral(currentNow)}
        ELSE last_completed_at
      END,
      last_error = CASE WHEN ${getSqlLiteral(isClaimFinished)} THEN NULL ELSE last_error END,
      worker_id = CASE WHEN ${getSqlLiteral(isClaimFinished)} THEN NULL ELSE worker_id END,
      lease_expires_at = CASE WHEN ${getSqlLiteral(isClaimFinished)} THEN NULL ELSE lease_expires_at END,
      updated_at = ${getTimestampLiteral(currentNow)}
    WHERE project_id = ${getSqlLiteral(projectId)}
      AND worker_id = ${getSqlLiteral(workerId)}
      AND refresh_status = 'running'
      AND active_dirty_token = ${completedToken}
    RETURNING
      project_id AS projectId,
      CAST(dirty_token AS INTEGER) AS dirtyToken,
      CAST(active_dirty_token AS INTEGER) AS activeDirtyToken,
      CAST(last_completed_dirty_token AS INTEGER) AS lastCompletedDirtyToken,
      refresh_status AS refreshStatus,
      worker_id AS workerId
  `)

  if (!completed) {
    return {completedState: null, isBlockedByQuarantine: false, isClaimComplete: false}
  }

  return {
    completedState: isCompletedThroughClaim ? await getProjectRefreshStateRecord(tx, projectId) : null,
    isBlockedByQuarantine,
    isClaimComplete: isCompletedThroughClaim,
  }
}

const completeDirtyArticleBatchForClaim = async ({
  articleIds,
  claimedToken,
  now,
  projectId,
  workerId,
}: CompleteDirtyArticleBatchForClaimParams): Promise<ProjectRefreshBatchCompletion> => {
  const currentNow = getNow(now)
  const completion = await getAppDatabaseService().transaction(async (tx) => {
    const [claimState] = await tx.queryJson<{lastCompletedDirtyToken: number}>(`
      SELECT CAST(last_completed_dirty_token AS INTEGER) AS lastCompletedDirtyToken
      FROM app.project_mart_refresh_state
      WHERE project_id = ${getSqlLiteral(projectId)}
        AND worker_id = ${getSqlLiteral(workerId)}
        AND refresh_status = 'running'
        AND active_dirty_token = ${claimedToken}
      LIMIT 1
    `)

    if (!claimState) {
      return {completedState: null, isBlockedByQuarantine: false, isClaimComplete: false}
    }

    const batchArticleIds = getUniqueValues(articleIds)

    if (batchArticleIds.length > 0) {
      await createDirtyRefreshArticleInputTable(tx, batchArticleIds)

      await tx.run(`
        DELETE FROM app.project_mart_refresh_article_state
        WHERE project_id = ${getSqlLiteral(projectId)}
          AND ${getDirtyRefreshArticleInputExistsSql('app.project_mart_refresh_article_state.article_id')}
          AND first_dirty_token <= ${claimedToken}
          AND last_dirty_token > ${claimState.lastCompletedDirtyToken}
          AND last_dirty_token <= ${claimedToken}
          AND NOT EXISTS (
            SELECT 1
            FROM app.project_mart_dirty_refresh_article_quarantine quarantine
            WHERE quarantine.project_id = app.project_mart_refresh_article_state.project_id
              AND quarantine.article_id = app.project_mart_refresh_article_state.article_id
              AND quarantine.dirty_token <= ${claimedToken}
              AND quarantine.resolved_at IS NULL
          )
      `)
      await tx.run(`
        UPDATE app.project_mart_refresh_article_state
        SET
          first_dirty_token = GREATEST(first_dirty_token, ${claimedToken + 1}),
          updated_at = ${getTimestampLiteral(currentNow)}
        WHERE project_id = ${getSqlLiteral(projectId)}
          AND ${getDirtyRefreshArticleInputExistsSql('app.project_mart_refresh_article_state.article_id')}
          AND first_dirty_token <= ${claimedToken}
          AND last_dirty_token > ${claimState.lastCompletedDirtyToken}
          AND last_dirty_token > ${claimedToken}
          AND NOT EXISTS (
            SELECT 1
            FROM app.project_mart_dirty_refresh_article_quarantine quarantine
            WHERE quarantine.project_id = app.project_mart_refresh_article_state.project_id
              AND quarantine.article_id = app.project_mart_refresh_article_state.article_id
              AND quarantine.dirty_token <= ${claimedToken}
              AND quarantine.resolved_at IS NULL
          )
      `)
      await dropDirtyRefreshArticleInputTable(tx)
    }

    const [remaining] = await tx.queryJson<{rowCount: number}>(`
      SELECT CAST(COUNT(*) AS INTEGER) AS rowCount
      FROM app.project_mart_refresh_article_state
      WHERE project_id = ${getSqlLiteral(projectId)}
        AND first_dirty_token <= ${claimedToken}
        AND last_dirty_token > ${claimState.lastCompletedDirtyToken}
        AND NOT EXISTS (
          SELECT 1
          FROM app.project_mart_dirty_refresh_article_quarantine quarantine
          WHERE quarantine.project_id = app.project_mart_refresh_article_state.project_id
            AND quarantine.article_id = app.project_mart_refresh_article_state.article_id
            AND quarantine.dirty_token <= ${claimedToken}
            AND quarantine.resolved_at IS NULL
        )
    `)

    return Number(remaining?.rowCount ?? 0) === 0
      ? completeRunningProjectRefreshState({completedToken: claimedToken, currentNow, projectId, tx, workerId})
      : {completedState: null, isBlockedByQuarantine: false, isClaimComplete: false}
  })

  if (completion.isClaimComplete || completion.isBlockedByQuarantine) {
    await getMaintenanceWorkLeaseService().completeMaintenanceWorkLease({
      consumerId: workerId,
      now: currentNow,
      projectId,
      scopeKind: 'project',
      workKind: 'review_index_project_refresh',
    })
  }

  return completion
}

const completeProjectRefresh = async ({completedToken, now, projectId, workerId}: CompleteProjectRefreshParams) => {
  const currentNow = getNow(now)
  const completion = (await getAppDatabaseService().transaction(async (tx) => {
    return completeRunningProjectRefreshState({completedToken, currentNow, projectId, tx, workerId})
  })) as ProjectRefreshBatchCompletion

  if (completion.isClaimComplete || completion.isBlockedByQuarantine) {
    await getMaintenanceWorkLeaseService().completeMaintenanceWorkLease({
      consumerId: workerId,
      now: currentNow,
      projectId,
      scopeKind: 'project',
      workKind: 'review_index_project_refresh',
    })
  }

  return completion.completedState
}

const finalizeProjectRefreshAfterLargeRebuild = async ({
  completedToken,
  now,
  projectId,
}: FinalizeProjectRefreshAfterLargeRebuildParams) => {
  const currentNow = getNow(now)
  const completedState = await getAppDatabaseService().transaction(async (tx) => {
    await cleanupCompletedProjectRefreshArticleState({completedToken, currentNow, projectId, tx})

    const completionBarrier = await getDirtyTokenCompletionBarrier({completedToken, projectId, tx})
    const completedThroughToken = await getCompletedThroughDirtyToken({completedToken, projectId, tx})
    const isCompletedThroughRebuild = completedThroughToken >= completedToken
    const isBlockedByQuarantine = !isCompletedThroughRebuild && completionBarrier?.barrierKind === 'quarantine'
    const isRebuildFinished = isCompletedThroughRebuild || isBlockedByQuarantine
    const [completed] = await tx.queryJson<ProjectRefreshStateRow>(`
      UPDATE app.project_mart_refresh_state
      SET
        active_dirty_token = CASE
          WHEN ${getSqlLiteral(isCompletedThroughRebuild)} AND active_dirty_token <= ${completedToken} THEN 0
          WHEN ${getSqlLiteral(isBlockedByQuarantine)} AND active_dirty_token <= ${completedToken} THEN ${completedToken}
          ELSE active_dirty_token
        END,
        last_completed_dirty_token = GREATEST(last_completed_dirty_token, ${completedThroughToken}),
        refresh_status = CASE
          WHEN ${getSqlLiteral(isCompletedThroughRebuild)} AND active_dirty_token <= ${completedToken} THEN 'idle'
          WHEN ${getSqlLiteral(isBlockedByQuarantine)} AND active_dirty_token <= ${completedToken} THEN 'blocked_by_quarantine'
          ELSE refresh_status
        END,
        last_completed_at = CASE
          WHEN ${completedThroughToken} > last_completed_dirty_token THEN ${getTimestampLiteral(currentNow)}
          ELSE last_completed_at
        END,
        last_error = CASE
          WHEN ${getSqlLiteral(isRebuildFinished)} AND active_dirty_token <= ${completedToken} THEN NULL
          ELSE last_error
        END,
        worker_id = CASE
          WHEN ${getSqlLiteral(isRebuildFinished)} AND active_dirty_token <= ${completedToken} THEN NULL
          ELSE worker_id
        END,
        lease_expires_at = CASE
          WHEN ${getSqlLiteral(isRebuildFinished)} AND active_dirty_token <= ${completedToken} THEN NULL
          ELSE lease_expires_at
        END,
        updated_at = ${getTimestampLiteral(currentNow)}
      WHERE project_id = ${getSqlLiteral(projectId)}
      RETURNING
        project_id AS projectId,
        CAST(dirty_token AS INTEGER) AS dirtyToken,
        CAST(active_dirty_token AS INTEGER) AS activeDirtyToken,
        CAST(last_completed_dirty_token AS INTEGER) AS lastCompletedDirtyToken,
        refresh_status AS refreshStatus,
        worker_id AS workerId
    `)

    if (!completed || !isCompletedThroughRebuild) {
      return null
    }

    return getProjectRefreshStateRecord(tx, projectId)
  })

  if (completedState) {
    await getMaintenanceWorkLeaseService().completeMaintenanceWorkLease({
      now: currentNow,
      projectId,
      scopeKind: 'project',
      workKind: 'review_index_project_refresh',
    })
  }

  return completedState
}

const failProjectRefresh = async ({error, now, projectId, workerId}: FailProjectRefreshParams) => {
  const currentNow = getNow(now)
  const [failed] = await getAppDatabaseService().queryJson<ProjectRefreshStateRow>(`
    UPDATE app.project_mart_refresh_state
    SET
      active_dirty_token = 0,
      refresh_status = 'failed',
      last_failed_at = ${getTimestampLiteral(currentNow)},
      last_error = ${getSqlLiteral(error)},
      worker_id = NULL,
      lease_expires_at = NULL,
      updated_at = ${getTimestampLiteral(currentNow)}
    WHERE project_id = ${getSqlLiteral(projectId)}
      AND worker_id = ${getSqlLiteral(workerId)}
      AND refresh_status = 'running'
    RETURNING
      project_id AS projectId,
      CAST(dirty_token AS INTEGER) AS dirtyToken,
      CAST(active_dirty_token AS INTEGER) AS activeDirtyToken,
      CAST(last_completed_dirty_token AS INTEGER) AS lastCompletedDirtyToken,
      refresh_status AS refreshStatus,
      worker_id AS workerId
  `)

  if (failed) {
    await getMaintenanceWorkLeaseService().completeMaintenanceWorkLease({
      consumerId: workerId,
      now: currentNow,
      projectId,
      scopeKind: 'project',
      workKind: 'review_index_project_refresh',
    })
  }

  return failed ? getProjectRefreshStateRecord(getAppDatabaseService(), projectId) : null
}

const projectMartDirtyRefreshStateService = {
  claimDirtyProjects,
  cleanupResolvedProjectRefreshArticleQuarantines,
  clearArchivedProjectRefreshStates,
  clearProjectRefreshState,
  completeDirtyArticleBatchForClaim,
  completeProjectRefresh,
  failProjectRefresh,
  finalizeProjectRefreshAfterLargeRebuild,
  getDirtyArticleBatchForClaim,
  getDirtyProjectsForProjectIds,
  getDirtyArticlesForClaim,
  getQuarantinedArticlesForProject,
  heartbeatClaim,
  markArticleProjectsDirtyAtomically,
  markProjectsDirtyAtomically,
  quarantineProjectRefreshArticle,
  releaseProjectRefreshClaim,
  resolveProjectRefreshArticleQuarantine,
}

export const getProjectMartDirtyRefreshStateService = () => {
  return projectMartDirtyRefreshStateService
}

export {
  claimDirtyProjects,
  cleanupResolvedProjectRefreshArticleQuarantines,
  completeDirtyArticleBatchForClaim,
  completeProjectRefresh,
  failProjectRefresh,
  finalizeProjectRefreshAfterLargeRebuild,
  getDirtyArticleBatchForClaim,
  getDirtyArticlesForClaim,
  getDirtyProjectsForProjectIds,
  heartbeatClaim,
  markArticleProjectsDirtyAtomically,
  markProjectsDirtyAtomically,
  resolveProjectRefreshArticleQuarantine,
}

export type {
  ClaimDirtyProjectsParams,
  CleanupResolvedProjectRefreshArticleQuarantinesParams,
  CompleteDirtyArticleBatchForClaimParams,
  CompleteProjectRefreshParams,
  DirtyArticleBatchForClaim,
  DirtyProjectInput,
  FailProjectRefreshParams,
  FinalizeProjectRefreshAfterLargeRebuildParams,
  GetDirtyArticleBatchForClaimParams,
  GetDirtyArticlesForClaimParams,
  HeartbeatClaimParams,
  MarkArticleProjectsDirtyAtomicallyParams,
  MarkedProjectDirtyState,
  MarkProjectsDirtyAtomicallyParams,
  ProjectRefreshBatchCompletion,
  ProjectRefreshClaim,
  ResolveProjectRefreshArticleQuarantineParams,
}
