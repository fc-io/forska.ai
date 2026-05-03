import type {
  ProjectMartDirtyRefreshStateRecord,
  ProjectMartRefreshArticleQuarantineRecord,
  ProjectMartRefreshStatus,
} from '../../db/schemaTypes.ts'
import {getAppDatabaseService} from './appDatabaseService.ts'
import {getQuotedStringList, getSqlLiteral, getTimestampLiteral} from './appQueryHelpers.ts'
import {getMaintenanceWorkLeaseService} from './maintenanceWorkLeaseService.ts'

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
  error: string
  now?: Date
  runner?: RefreshStateRunner
}

type GetQuarantinedArticlesForProjectParams = {articleIds?: string[]; projectId: string; runner?: RefreshStateRunner}

type FailProjectRefreshParams = {error: string; now?: Date; projectId: string; workerId: string}

type ProjectRefreshStateRow = {
  activeDirtyToken: number
  dirtyToken: number
  lastCompletedDirtyToken: number
  projectId: string
  refreshStatus: ProjectMartRefreshStatus
  workerId: string | null
}

const getNow = (value?: Date) => {
  return value ?? new Date()
}

const getLeaseExpiry = (now: Date, leaseMs: number) => {
  return new Date(now.getTime() + leaseMs)
}

const getUniqueValues = (values: string[]) => {
  return Array.from(new Set(values))
}

const getNormalizedBatchSize = (batchSize: number) => {
  return Math.max(0, Math.floor(batchSize))
}

const normalizeDirtyProjects = (projects: DirtyProjectInput[]) => {
  return projects.reduce((acc, project) => {
    const existing = acc.get(project.projectId)
    const articleIds = getUniqueValues(project.articleIds ?? [])

    acc.set(project.projectId, {
      articleIds: getUniqueValues([...(existing?.articleIds ?? []), ...articleIds]),
      projectId: project.projectId,
    })

    return acc
  }, new Map<string, {articleIds: string[]; projectId: string}>())
}

const ensureProjectRefreshStateRow = async (runner: RefreshStateRunner, projectId: string) => {
  await runner.run(`
    INSERT INTO app.project_mart_refresh_state (project_id)
    VALUES (${getSqlLiteral(projectId)})
    ON CONFLICT(project_id) DO NOTHING
  `)
}

const getProjectRefreshArticleQuarantineRecord = async (runner: RefreshStateRunner, articleId: string) => {
  const [row] = await runner.queryJson<ProjectMartRefreshArticleQuarantineRecord>(`
    SELECT
      article_id AS articleId,
      error,
      detected_by AS detectedBy,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM app.project_mart_refresh_article_quarantine
    WHERE article_id = ${getSqlLiteral(articleId)}
    LIMIT 1
  `)

  return row ?? null
}

const markSingleProjectDirty = async (
  runner: RefreshStateRunner,
  project: {articleIds: string[]; projectId: string},
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

  if (project.articleIds.length > 0) {
    await runner.run(`
      INSERT INTO app.project_mart_refresh_article_state (
        project_id,
        article_id,
        first_dirty_token,
        last_dirty_token,
        updated_at
      ) VALUES ${project.articleIds
        .map((articleId) => {
          return `(${getQuotedStringList([project.projectId, articleId]).join(', ')}, ${state.dirtyToken}, ${state.dirtyToken}, ${getTimestampLiteral(params.now)})`
        })
        .join(', ')}
      ON CONFLICT(project_id, article_id) DO UPDATE SET
        first_dirty_token = LEAST(app.project_mart_refresh_article_state.first_dirty_token, EXCLUDED.first_dirty_token),
        last_dirty_token = GREATEST(app.project_mart_refresh_article_state.last_dirty_token, EXCLUDED.last_dirty_token),
        updated_at = EXCLUDED.updated_at
    `)
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

  const rows = await runner.queryJson<DirtyProjectArticleRow>(`
    SELECT projectId, articleId
    FROM (
      SELECT
        project_article.project_id AS projectId,
        project_article.article_id AS articleId
      FROM app.project_article project_article
      INNER JOIN app.project project ON project.id = project_article.project_id
      WHERE project_article.article_id IN (${getQuotedStringList(uniqueArticleIds).join(', ')})
        AND project.archived = FALSE
      UNION
      SELECT
        project_import_route.project_id AS projectId,
        article_import_route.article_id AS articleId
      FROM app.article_import_route article_import_route
      INNER JOIN app.project_import_route project_import_route
        ON project_import_route.import_route_id = article_import_route.import_route_id
      INNER JOIN app.project project ON project.id = project_import_route.project_id
      WHERE article_import_route.article_id IN (${getQuotedStringList(uniqueArticleIds).join(', ')})
        AND project.archived = FALSE
    ) resolved_projects
    ORDER BY projectId ASC, articleId ASC
  `)

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

  const [projectRows, articleRows] = await Promise.all([
    runner.queryJson<DirtyProjectIdRow>(`
      SELECT id AS projectId
      FROM app.project
      WHERE id IN (${getQuotedStringList(uniqueProjectIds).join(', ')})
        AND archived = FALSE
      ORDER BY id ASC
    `),
    runner.queryJson<DirtyProjectArticleRow>(`
      SELECT projectId, articleId
      FROM (
        SELECT
          project_article.project_id AS projectId,
          project_article.article_id AS articleId
        FROM app.project_article project_article
        INNER JOIN app.project project ON project.id = project_article.project_id
        INNER JOIN app.article article ON article.id = project_article.article_id
        WHERE project_article.project_id IN (${getQuotedStringList(uniqueProjectIds).join(', ')})
          AND project.archived = FALSE
          AND (project.date_from IS NULL OR article.article_created_at >= project.date_from)
          AND (project.date_to IS NULL OR article.article_created_at <= project.date_to)
        UNION
        SELECT
          project_import_route.project_id AS projectId,
          article_import_route.article_id AS articleId
        FROM app.article_import_route article_import_route
        INNER JOIN app.project_import_route project_import_route
          ON project_import_route.import_route_id = article_import_route.import_route_id
        INNER JOIN app.project project ON project.id = project_import_route.project_id
        INNER JOIN app.article article ON article.id = article_import_route.article_id
        WHERE project_import_route.project_id IN (${getQuotedStringList(uniqueProjectIds).join(', ')})
          AND project.archived = FALSE
          AND (project.date_from IS NULL OR article.article_created_at >= project.date_from)
          AND (project.date_to IS NULL OR article.article_created_at <= project.date_to)
        UNION
        SELECT
          scope_article.project_id AS projectId,
          scope_article.article_id AS articleId
        FROM mart.project_scope_article scope_article
        INNER JOIN app.project project ON project.id = scope_article.project_id
        WHERE scope_article.project_id IN (${getQuotedStringList(uniqueProjectIds).join(', ')})
          AND project.archived = FALSE
      ) scoped_articles
      ORDER BY projectId ASC, articleId ASC
    `),
  ])

  return projectRows.map((project) => {
    return {
      articleIds: articleRows
        .filter((row) => {
          return row.projectId === project.projectId
        })
        .map((row) => {
          return row.articleId
        }),
      projectId: project.projectId,
    }
  })
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
      AND (
        state.refresh_status <> 'running'
        OR state.lease_expires_at IS NULL
        OR state.lease_expires_at <= ${getTimestampLiteral(currentNow)}
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
        AND (
          refresh_status <> 'running'
          OR lease_expires_at IS NULL
          OR lease_expires_at <= ${getTimestampLiteral(currentNow)}
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
    LEFT JOIN app.project_mart_refresh_article_quarantine quarantine
      ON quarantine.article_id = article_state.article_id
    WHERE state.project_id = ${getSqlLiteral(projectId)}
      AND state.worker_id = ${getSqlLiteral(workerId)}
      AND state.refresh_status = 'running'
      AND state.active_dirty_token = ${claimedToken}
      AND article_state.first_dirty_token <= state.active_dirty_token
      AND article_state.last_dirty_token > state.last_completed_dirty_token
      AND quarantine.article_id IS NULL
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
  const idsFilter =
    articleIds && articleIds.length > 0
      ? `AND quarantine.article_id IN (${getQuotedStringList(getUniqueValues(articleIds)).join(', ')})`
      : ''

  return activeRunner.queryJson<ProjectMartRefreshArticleQuarantineRecord>(`
    SELECT
      quarantine.article_id AS articleId,
      quarantine.error,
      quarantine.detected_by AS detectedBy,
      quarantine.created_at AS createdAt,
      quarantine.updated_at AS updatedAt
    FROM app.project_mart_refresh_article_quarantine quarantine
    INNER JOIN app.project_mart_refresh_article_state article_state
      ON article_state.article_id = quarantine.article_id
    WHERE article_state.project_id = ${getSqlLiteral(projectId)}
      ${idsFilter}
    GROUP BY 1, 2, 3, 4, 5
    ORDER BY quarantine.article_id ASC
  `)
}

const quarantineProjectRefreshArticle = async ({
  articleId,
  detectedBy = null,
  error,
  now,
  runner,
}: QuarantineProjectRefreshArticleParams) => {
  return withTransaction(runner, async (tx) => {
    const currentNow = getNow(now)
    await tx.run(`
      INSERT INTO app.project_mart_refresh_article_quarantine (
        article_id,
        error,
        detected_by,
        created_at,
        updated_at
      ) VALUES (
        ${getSqlLiteral(articleId)},
        ${getSqlLiteral(error)},
        ${getSqlLiteral(detectedBy)},
        ${getTimestampLiteral(currentNow)},
        ${getTimestampLiteral(currentNow)}
      )
      ON CONFLICT(article_id) DO UPDATE SET
        error = EXCLUDED.error,
        detected_by = EXCLUDED.detected_by,
        updated_at = EXCLUDED.updated_at
    `)

    return getProjectRefreshArticleQuarantineRecord(tx, articleId)
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
        FROM app.project_mart_refresh_article_quarantine quarantine
        WHERE quarantine.article_id = app.project_mart_refresh_article_state.article_id
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
        FROM app.project_mart_refresh_article_quarantine quarantine
        WHERE quarantine.article_id = app.project_mart_refresh_article_state.article_id
      )
  `)
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
}) => {
  const [completed] = await tx.queryJson<ProjectRefreshStateRow>(`
    UPDATE app.project_mart_refresh_state
    SET
      active_dirty_token = 0,
      last_completed_dirty_token = GREATEST(last_completed_dirty_token, ${completedToken}),
      refresh_status = 'idle',
      last_completed_at = ${getTimestampLiteral(currentNow)},
      last_error = NULL,
      worker_id = NULL,
      lease_expires_at = NULL,
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
    return null
  }

  await cleanupCompletedProjectRefreshArticleState({completedToken, currentNow, projectId, tx})

  return getProjectRefreshStateRecord(tx, projectId)
}

const completeDirtyArticleBatchForClaim = async ({
  articleIds,
  claimedToken,
  now,
  projectId,
  workerId,
}: CompleteDirtyArticleBatchForClaimParams): Promise<ProjectRefreshBatchCompletion> => {
  const currentNow = getNow(now)
  const completedState = await getAppDatabaseService().transaction(async (tx) => {
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
      return null
    }

    const batchArticleIds = getUniqueValues(articleIds)

    if (batchArticleIds.length > 0) {
      const batchArticleIdsSql = getQuotedStringList(batchArticleIds).join(', ')

      await tx.run(`
        DELETE FROM app.project_mart_refresh_article_state
        WHERE project_id = ${getSqlLiteral(projectId)}
          AND article_id IN (${batchArticleIdsSql})
          AND first_dirty_token <= ${claimedToken}
          AND last_dirty_token > ${claimState.lastCompletedDirtyToken}
          AND last_dirty_token <= ${claimedToken}
      `)
      await tx.run(`
        UPDATE app.project_mart_refresh_article_state
        SET
          first_dirty_token = GREATEST(first_dirty_token, ${claimedToken + 1}),
          updated_at = ${getTimestampLiteral(currentNow)}
        WHERE project_id = ${getSqlLiteral(projectId)}
          AND article_id IN (${batchArticleIdsSql})
          AND first_dirty_token <= ${claimedToken}
          AND last_dirty_token > ${claimState.lastCompletedDirtyToken}
          AND last_dirty_token > ${claimedToken}
      `)
    }

    const [remaining] = await tx.queryJson<{rowCount: number}>(`
      SELECT CAST(COUNT(*) AS INTEGER) AS rowCount
      FROM app.project_mart_refresh_article_state
      WHERE project_id = ${getSqlLiteral(projectId)}
        AND first_dirty_token <= ${claimedToken}
        AND last_dirty_token > ${claimState.lastCompletedDirtyToken}
        AND NOT EXISTS (
          SELECT 1
          FROM app.project_mart_refresh_article_quarantine quarantine
          WHERE quarantine.article_id = app.project_mart_refresh_article_state.article_id
        )
    `)

    return Number(remaining?.rowCount ?? 0) === 0
      ? completeRunningProjectRefreshState({completedToken: claimedToken, currentNow, projectId, tx, workerId})
      : null
  })

  if (completedState) {
    await getMaintenanceWorkLeaseService().completeMaintenanceWorkLease({
      consumerId: workerId,
      now: currentNow,
      projectId,
      scopeKind: 'project',
      workKind: 'review_index_project_refresh',
    })
  }

  return {completedState, isClaimComplete: Boolean(completedState)}
}

const completeProjectRefresh = async ({completedToken, now, projectId, workerId}: CompleteProjectRefreshParams) => {
  const currentNow = getNow(now)
  const completedState = await getAppDatabaseService().transaction(async (tx) => {
    return completeRunningProjectRefreshState({completedToken, currentNow, projectId, tx, workerId})
  })

  if (completedState) {
    await getMaintenanceWorkLeaseService().completeMaintenanceWorkLease({
      consumerId: workerId,
      now: currentNow,
      projectId,
      scopeKind: 'project',
      workKind: 'review_index_project_refresh',
    })
  }

  return completedState
}

const finalizeProjectRefreshAfterLargeRebuild = async ({
  completedToken,
  now,
  projectId,
}: FinalizeProjectRefreshAfterLargeRebuildParams) => {
  const currentNow = getNow(now)
  const completedState = await getAppDatabaseService().transaction(async (tx) => {
    const [completed] = await tx.queryJson<ProjectRefreshStateRow>(`
      UPDATE app.project_mart_refresh_state
      SET
        active_dirty_token = CASE WHEN active_dirty_token <= ${completedToken} THEN 0 ELSE active_dirty_token END,
        last_completed_dirty_token = GREATEST(last_completed_dirty_token, ${completedToken}),
        refresh_status = CASE WHEN active_dirty_token <= ${completedToken} THEN 'idle' ELSE refresh_status END,
        last_completed_at = ${getTimestampLiteral(currentNow)},
        last_error = CASE WHEN active_dirty_token <= ${completedToken} THEN NULL ELSE last_error END,
        worker_id = CASE WHEN active_dirty_token <= ${completedToken} THEN NULL ELSE worker_id END,
        lease_expires_at = CASE WHEN active_dirty_token <= ${completedToken} THEN NULL ELSE lease_expires_at END,
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

    if (!completed) {
      return null
    }

    await cleanupCompletedProjectRefreshArticleState({completedToken, currentNow, projectId, tx})

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
}

export const getProjectMartDirtyRefreshStateService = () => {
  return projectMartDirtyRefreshStateService
}

export {
  claimDirtyProjects,
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
}

export type {
  ClaimDirtyProjectsParams,
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
}
