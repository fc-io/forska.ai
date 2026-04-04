import type {
  ProjectMartRefreshArticleQuarantineRecord,
  ProjectMartRefreshStateRecord,
  ProjectMartRefreshStatus,
} from '../../db/schemaTypes.ts'
import {getAppDatabaseService} from './appDatabaseService.ts'
import {getQuotedStringList, getSqlLiteral, getTimestampLiteral} from './appQueryHelpers.ts'

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

type GetDirtyArticlesForClaimParams = {claimedToken: number; lastCompletedToken: number; projectId: string}

type CompleteProjectRefreshParams = {completedToken: number; now?: Date; projectId: string; workerId: string}

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

type GetQuarantinedArticlesForProjectParams = {
  articleIds?: string[]
  projectId: string
  runner?: RefreshStateRunner
}

type FailProjectRefreshParams = {error: string; now?: Date; projectId: string; workerId: string}

type ProjectRefreshStateRow = {
  activeRefreshToken: number
  dirtyToken: number
  lastCompletedRefreshToken: number
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

const getQuarantinedArticleIds = async (runner: RefreshStateRunner, articleIds: string[]) => {
  const uniqueArticleIds = getUniqueValues(articleIds)

  if (uniqueArticleIds.length === 0) {
    return []
  }

  const rows = await runner.queryJson<{articleId: string}>(`
    SELECT article_id AS articleId
    FROM app.project_mart_refresh_article_quarantine
    WHERE article_id IN (${getQuotedStringList(uniqueArticleIds).join(', ')})
    ORDER BY article_id ASC
  `)

  return rows.map((row) => {
    return row.articleId
  })
}

const getQuarantinedRefreshArticleError = ({articleId, error}: {articleId: string; error: string}) => {
  return `Quarantined project mart refresh article ${articleId}: ${error}`
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

    const quarantinedArticleIds = await getQuarantinedArticleIds(runner, project.articleIds)
    const [firstQuarantinedArticleId = ''] = quarantinedArticleIds

    if (firstQuarantinedArticleId !== '') {
      const quarantineRecord = await getProjectRefreshArticleQuarantineRecord(runner, firstQuarantinedArticleId)

      await runner.run(`
        UPDATE app.project_mart_refresh_state
        SET
          refresh_status = 'failed',
          last_failed_at = ${getTimestampLiteral(params.now)},
          last_error = ${getSqlLiteral(
            getQuarantinedRefreshArticleError({
              articleId: firstQuarantinedArticleId,
              error: quarantineRecord?.error ?? 'quarantined article refresh blocked',
            }),
          )},
          worker_id = NULL,
          lease_expires_at = NULL,
          active_refresh_token = 0,
          updated_at = ${getTimestampLiteral(params.now)}
        WHERE project_id = ${getSqlLiteral(project.projectId)}
      `)
    }
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
  const [row] = await runner.queryJson<ProjectMartRefreshStateRecord>(`
    SELECT
      project_id AS projectId,
      CAST(dirty_token AS INTEGER) AS dirtyToken,
      CAST(active_refresh_token AS INTEGER) AS activeRefreshToken,
      CAST(last_completed_refresh_token AS INTEGER) AS lastCompletedRefreshToken,
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
  const claimableRows = await getAppDatabaseService().queryJson<{dirtyToken: number; lastCompletedToken: number; projectId: string}>(`
    SELECT
      state.project_id AS projectId,
      CAST(state.dirty_token AS INTEGER) AS dirtyToken,
      CAST(state.last_completed_refresh_token AS INTEGER) AS lastCompletedToken
    FROM app.project_mart_refresh_state state
    INNER JOIN app.project project ON project.id = state.project_id
    WHERE project.archived = FALSE
      AND state.dirty_token > state.last_completed_refresh_token
      AND NOT EXISTS (
        SELECT 1
        FROM app.project_mart_refresh_article_state article_state
        INNER JOIN app.project_mart_refresh_article_quarantine quarantine
          ON quarantine.article_id = article_state.article_id
        WHERE article_state.project_id = state.project_id
          AND article_state.first_dirty_token <= state.dirty_token
          AND article_state.last_dirty_token > state.last_completed_refresh_token
      )
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
        active_refresh_token=${row.dirtyToken},
        refresh_status = 'running',
        last_started_at = ${getTimestampLiteral(currentNow)},
        last_error = NULL,
        worker_id = ${getSqlLiteral(workerId)},
        lease_expires_at = ${getTimestampLiteral(leaseExpiresAt)},
        updated_at = ${getTimestampLiteral(currentNow)}
      WHERE project_id = ${getSqlLiteral(row.projectId)}
        AND dirty_token > last_completed_refresh_token
        AND (
          refresh_status <> 'running'
          OR lease_expires_at IS NULL
          OR lease_expires_at <= ${getTimestampLiteral(currentNow)}
        )
      RETURNING
        project_id AS projectId,
        ${getSqlLiteral(workerId)} AS workerId,
        CAST(active_refresh_token AS INTEGER) AS claimedToken,
        CAST(last_completed_refresh_token AS INTEGER) AS lastCompletedToken,
        lease_expires_at AS leaseExpiresAt
    `)

    return claimed ? [...acc, claimed] : acc
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
      CAST(active_refresh_token AS INTEGER) AS claimedToken,
      CAST(last_completed_refresh_token AS INTEGER) AS lastCompletedToken,
      lease_expires_at AS leaseExpiresAt
  `)

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

const releaseProjectRefreshClaim = async ({now, projectId, workerId}: ReleaseProjectRefreshClaimParams) => {
  const currentNow = getNow(now)
  const [released] = await getAppDatabaseService().queryJson<ProjectRefreshStateRow>(`
    UPDATE app.project_mart_refresh_state
    SET
      active_refresh_token=0,
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
      CAST(active_refresh_token AS INTEGER) AS activeRefreshToken,
      CAST(last_completed_refresh_token AS INTEGER) AS lastCompletedRefreshToken,
      refresh_status AS refreshStatus,
      worker_id AS workerId
  `)

  return released ? getProjectRefreshStateRecord(getAppDatabaseService(), projectId) : null
}

const clearProjectRefreshState = async ({now, projectId, runner}: ClearProjectRefreshStateParams) => {
  return withTransaction(runner, async (tx) => {
    const currentNow = getNow(now)

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

const getQuarantinedArticlesForProject = async ({articleIds, projectId, runner}: GetQuarantinedArticlesForProjectParams) => {
  const activeRunner = runner ?? getAppDatabaseService()
  const idsFilter = articleIds && articleIds.length > 0 ? `AND quarantine.article_id IN (${getQuotedStringList(getUniqueValues(articleIds)).join(', ')})` : ''

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
    const quarantineError = getQuarantinedRefreshArticleError({articleId, error})

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

    await tx.run(`
      UPDATE app.project_mart_refresh_state
      SET
        refresh_status = 'failed',
        last_failed_at = ${getTimestampLiteral(currentNow)},
        last_error = ${getSqlLiteral(quarantineError)},
        worker_id = NULL,
        lease_expires_at = NULL,
        active_refresh_token = 0,
        updated_at = ${getTimestampLiteral(currentNow)}
      WHERE project_id IN (
        SELECT DISTINCT project_id
        FROM app.project_mart_refresh_article_state
        WHERE article_id = ${getSqlLiteral(articleId)}
      )
    `)

    return getProjectRefreshArticleQuarantineRecord(tx, articleId)
  })
}

const completeProjectRefresh = async ({completedToken, now, projectId, workerId}: CompleteProjectRefreshParams) => {
  return getAppDatabaseService().transaction(async (tx) => {
    const currentNow = getNow(now)
    const [completed] = await tx.queryJson<ProjectRefreshStateRow>(`
      UPDATE app.project_mart_refresh_state
      SET
        active_refresh_token = 0,
        last_completed_refresh_token = GREATEST(last_completed_refresh_token, ${completedToken}),
        refresh_status = 'idle',
        last_completed_at = ${getTimestampLiteral(currentNow)},
        last_error = NULL,
        worker_id = NULL,
        lease_expires_at = NULL,
        updated_at = ${getTimestampLiteral(currentNow)}
      WHERE project_id = ${getSqlLiteral(projectId)}
        AND worker_id = ${getSqlLiteral(workerId)}
        AND refresh_status = 'running'
        AND active_refresh_token = ${completedToken}
      RETURNING
        project_id AS projectId,
        CAST(dirty_token AS INTEGER) AS dirtyToken,
        CAST(active_refresh_token AS INTEGER) AS activeRefreshToken,
        CAST(last_completed_refresh_token AS INTEGER) AS lastCompletedRefreshToken,
        refresh_status AS refreshStatus,
        worker_id AS workerId
    `)

    if (!completed) {
      return null
    }

    await tx.run(`
      DELETE FROM app.project_mart_refresh_article_state
      WHERE project_id = ${getSqlLiteral(projectId)}
        AND last_dirty_token <= ${completedToken}
    `)
    await tx.run(`
      UPDATE app.project_mart_refresh_article_state
      SET
        first_dirty_token = GREATEST(first_dirty_token, ${completedToken + 1}),
        updated_at = ${getTimestampLiteral(currentNow)}
      WHERE project_id = ${getSqlLiteral(projectId)}
        AND first_dirty_token <= ${completedToken}
        AND last_dirty_token > ${completedToken}
    `)

    return getProjectRefreshStateRecord(tx, projectId)
  })
}

const failProjectRefresh = async ({error, now, projectId, workerId}: FailProjectRefreshParams) => {
  const currentNow = getNow(now)
  const [failed] = await getAppDatabaseService().queryJson<ProjectRefreshStateRow>(`
    UPDATE app.project_mart_refresh_state
    SET
      active_refresh_token = 0,
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
      CAST(active_refresh_token AS INTEGER) AS activeRefreshToken,
      CAST(last_completed_refresh_token AS INTEGER) AS lastCompletedRefreshToken,
      refresh_status AS refreshStatus,
      worker_id AS workerId
  `)

  return failed ? getProjectRefreshStateRecord(getAppDatabaseService(), projectId) : null
}

const projectMartRefreshStateService = {
  claimDirtyProjects,
  clearArchivedProjectRefreshStates,
  clearProjectRefreshState,
  completeProjectRefresh,
  failProjectRefresh,
  getDirtyProjectsForProjectIds,
  getDirtyArticlesForClaim,
  getQuarantinedArticlesForProject,
  heartbeatClaim,
  markArticleProjectsDirtyAtomically,
  markProjectsDirtyAtomically,
  quarantineProjectRefreshArticle,
  releaseProjectRefreshClaim,
}

export const getProjectMartRefreshStateService = () => {
  return projectMartRefreshStateService
}

export {
  claimDirtyProjects,
  completeProjectRefresh,
  failProjectRefresh,
  getDirtyArticlesForClaim,
  getDirtyProjectsForProjectIds,
  heartbeatClaim,
  markArticleProjectsDirtyAtomically,
  markProjectsDirtyAtomically,
}

export type {
  ClaimDirtyProjectsParams,
  CompleteProjectRefreshParams,
  DirtyProjectInput,
  FailProjectRefreshParams,
  GetDirtyArticlesForClaimParams,
  HeartbeatClaimParams,
  MarkArticleProjectsDirtyAtomicallyParams,
  MarkedProjectDirtyState,
  MarkProjectsDirtyAtomicallyParams,
  ProjectRefreshClaim,
}
