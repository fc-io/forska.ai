import {hostname} from 'node:os'

import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {getDuckdbMartMaintenanceService} from '../src/server/services/getDuckdbMartMaintenanceService.ts'
import {getMaintenanceWorkLeaseService} from '../src/server/services/maintenanceWorkLeaseService.ts'
import {getProjectMartDirtyRefreshStateService} from '../src/server/services/projectMartDirtyRefreshStateService.ts'
import {runProjectMartLargeRebuildCycle} from '../src/server/services/projectMartLargeRebuildRunner.ts'
import {getProjectMartLargeRebuildStateService} from '../src/server/services/projectMartLargeRebuildStateService.ts'
import {legacyDirtyRefreshAckValue, legacyLargeRebuildAckValue, requireLegacyAdminAck} from './legacyAdminAck.ts'

type CliOptions = {
  heartbeatMs: number | undefined
  incrementalArticleThreshold: number
  leaseMs: number
  maxFullProjectScopeArticles: number
  projectId: string | undefined
  workerId: string
}

type Claim = {claimedToken: number; lastCompletedToken: number; projectId: string; workerId: string}

const defaultLeaseMs = 30_000
const defaultHeartbeatMs = 10_000
const defaultIncrementalArticleThreshold = 3
const defaultMaxFullProjectScopeArticles = 100_000

const getArgValue = (names: string[]) => {
  const matchedArgument = process.argv.slice(2).find((argument) => {
    return names.some((name) => {
      return argument.startsWith(`${name}=`)
    })
  })

  return matchedArgument?.slice(matchedArgument.indexOf('=') + 1)
}

const getNumberArgValue = (names: string[]) => {
  const rawValue = getArgValue(names)
  const parsed = Number(rawValue)

  return rawValue === undefined || Number.isNaN(parsed) ? undefined : parsed
}

const getExecutionMode = ({
  dirtyArticleCount,
  incrementalArticleThreshold,
}: {
  dirtyArticleCount: number
  incrementalArticleThreshold: number
}) => {
  return dirtyArticleCount === 0 ? 'idle' : dirtyArticleCount <= incrementalArticleThreshold ? 'incremental' : 'full'
}

const getCliOptions = (): CliOptions => {
  const workerId =
    getArgValue(['--workerId', '--worker-id']) ?? `project-mart-refresh-worker-isolated:${hostname()}:${process.pid}`
  const envMaxFullProjectScopeArticles = Number(process.env.PROJECT_MART_REFRESH_MAX_FULL_SCOPE_ARTICLES ?? '')
  const maxFullProjectScopeArticles =
    getNumberArgValue(['--maxFullProjectScopeArticles', '--max-full-project-scope-articles'])
    ?? (Number.isFinite(envMaxFullProjectScopeArticles) && envMaxFullProjectScopeArticles > 0
      ? envMaxFullProjectScopeArticles
      : defaultMaxFullProjectScopeArticles)

  return {
    heartbeatMs: getNumberArgValue(['--heartbeatMs', '--heartbeat-ms']) ?? defaultHeartbeatMs,
    incrementalArticleThreshold:
      getNumberArgValue(['--incrementalArticleThreshold', '--incremental-article-threshold'])
      ?? defaultIncrementalArticleThreshold,
    leaseMs: getNumberArgValue(['--leaseMs', '--lease-ms']) ?? defaultLeaseMs,
    maxFullProjectScopeArticles,
    projectId: getArgValue(['--projectId', '--project-id']),
    workerId,
  }
}

const getErrorText = (error: unknown) => {
  return error instanceof Error ? error.message : String(error)
}

const claimProject = async ({
  leaseMs,
  projectId,
  workerId,
}: {
  leaseMs: number
  projectId?: string
  workerId: string
}) => {
  const stateService = getProjectMartDirtyRefreshStateService()

  if (!projectId) {
    const [claim] = await stateService.claimDirtyProjects({leaseMs, limit: 1, workerId})
    return claim ?? null
  }

  const currentNow = new Date()
  const leaseExpiresAt = new Date(currentNow.getTime() + leaseMs).toISOString()
  const [claim] = await getAppDatabaseService().queryJson<Claim>(`
    UPDATE app.project_mart_refresh_state
    SET
      active_dirty_token = dirty_token,
      refresh_status = 'running',
      last_started_at = TIMESTAMPTZ '${currentNow.toISOString()}',
      last_error = NULL,
      worker_id = '${workerId}',
      lease_expires_at = TIMESTAMPTZ '${leaseExpiresAt}',
      updated_at = TIMESTAMPTZ '${currentNow.toISOString()}'
    WHERE project_id = '${projectId}'
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
        OR lease_expires_at <= TIMESTAMPTZ '${currentNow.toISOString()}'
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
      worker_id AS workerId,
      CAST(active_dirty_token AS INTEGER) AS claimedToken,
      CAST(last_completed_dirty_token AS INTEGER) AS lastCompletedToken
  `)

  if (claim) {
    await getMaintenanceWorkLeaseService().claimMaintenanceWorkLease({
      consumerId: workerId,
      leaseMs,
      now: currentNow,
      projectId: claim.projectId,
      requiredConsumerRole: 'maintenance-worker',
      scopeKind: 'project',
      workKind: 'review_index_project_refresh',
    })
  }

  return claim ?? null
}

const startHeartbeat = (claim: Claim, heartbeatMs: number, leaseMs: number) => {
  const stateService = getProjectMartDirtyRefreshStateService()
  const interval = setInterval(() => {
    return void stateService.heartbeatClaim({leaseMs, projectId: claim.projectId, workerId: claim.workerId})
  }, heartbeatMs)

  interval.unref()

  return () => {
    clearInterval(interval)
  }
}

export const runProjectMartRefreshWorkerOnceIsolated = async () => {
  if (
    !requireLegacyAdminAck({
      command: 'runProjectMartRefreshWorkerOnceIsolated',
      expectedAck: legacyDirtyRefreshAckValue,
    })
  ) {
    return
  }

  const options = getCliOptions()
  const largeRebuildStateService = getProjectMartLargeRebuildStateService()
  const stateService = getProjectMartDirtyRefreshStateService()
  const refreshService = getDuckdbMartMaintenanceService()

  try {
    const claim = await claimProject({
      leaseMs: options.leaseMs,
      projectId: options.projectId,
      workerId: options.workerId,
    })

    if (!claim) {
      if (
        !requireLegacyAdminAck({
          command: 'runProjectMartRefreshWorkerOnceIsolated:largeRebuildFallback',
          expectedAck: legacyLargeRebuildAckValue,
        })
      ) {
        return
      }

      const largeRebuildResult = await runProjectMartLargeRebuildCycle({
        heartbeatMs: options.heartbeatMs,
        leaseMs: options.leaseMs,
        workerId: options.workerId,
      })

      console.log(JSON.stringify(largeRebuildResult))
      process.exitCode = largeRebuildResult.status === 'failed' ? 1 : 0
      return
    }

    const stopHeartbeat = startHeartbeat(claim, options.heartbeatMs ?? defaultHeartbeatMs, options.leaseMs)

    try {
      const dirtyArticles = await stateService.getDirtyArticlesForClaim({
        claimedToken: claim.claimedToken,
        lastCompletedToken: claim.lastCompletedToken,
        projectId: claim.projectId,
      })
      const dirtyArticleIds = dirtyArticles.map((row) => {
        return row.articleId
      })
      const executionMode = getExecutionMode({
        dirtyArticleCount: dirtyArticleIds.length,
        incrementalArticleThreshold: options.incrementalArticleThreshold,
      })

      if (executionMode === 'incremental') {
        await refreshService.refreshDirtyProjectArticleBatch(claim.projectId, dirtyArticleIds)
      }

      if (executionMode === 'full') {
        await largeRebuildStateService.requestLargeRebuild({
          now: new Date(),
          projectId: claim.projectId,
          rebuildPhase: 'project_scope_article',
          refreshToken: claim.claimedToken,
        })
        await stateService.releaseProjectRefreshClaim({projectId: claim.projectId, workerId: options.workerId})
        console.log(
          JSON.stringify({
            claimedToken: claim.claimedToken,
            projectId: claim.projectId,
            status: 'completed',
            workerId: options.workerId,
          }),
        )
        return
      }

      await stateService.completeProjectRefresh({
        completedToken: claim.claimedToken,
        projectId: claim.projectId,
        workerId: options.workerId,
      })
      console.log(
        JSON.stringify({
          claimedToken: claim.claimedToken,
          projectId: claim.projectId,
          status: 'completed',
          workerId: options.workerId,
        }),
      )
    } catch (error) {
      const errorText = getErrorText(error)

      await stateService.failProjectRefresh({error: errorText, projectId: claim.projectId, workerId: options.workerId})
      console.log(
        JSON.stringify({
          claimedToken: claim.claimedToken,
          error: errorText,
          projectId: claim.projectId,
          status: 'failed',
          workerId: options.workerId,
        }),
      )
      process.exitCode = 1
    } finally {
      stopHeartbeat()
    }
  } finally {
    await getAppDatabaseService().close()
  }
}

void runProjectMartRefreshWorkerOnceIsolated()
