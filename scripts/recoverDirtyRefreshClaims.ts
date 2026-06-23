import {requestReviewServingV4Rebuilds} from '../src/server/reviewServing/reviewServingV4RebuildRequestService.ts'
import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'

type CliOptions = {recover: boolean; yes: boolean}

type RecoveryResult = {kind: 'v4_rebuild_request'; projectIds: string[]; reason: string; requestIds: string[]}

type StaleDirtyRefreshClaimRow = {
  activeDirtyToken: number | string
  dirtyToken: number | string
  lastCompletedDirtyToken: number | string
  leaseExpiresAt: string
  projectId: string
  workerId: string | null
}

type StaleDirtyMaterializationClaimRow = {
  insertedRowCount: number | string
  leaseExpiresAt: string
  materializationOwner: string | null
  projectId: string
  sourceKind: string
  targetDirtyToken: number | string
}

type StaleLargeRebuildClaimRow = {
  leaseExpiresAt: string
  projectId: string
  rebuildPhase: string
  refreshToken: number | string
  workerId: string | null
}

type QuarantineBarrierRow = {articleId: string; dirtyToken: number | string; projectId: string}

const getBooleanFlag = (names: string[]) => {
  return process.argv.slice(2).some((argument) => {
    return names.includes(argument)
  })
}

const getCliOptions = (): CliOptions => {
  return {recover: getBooleanFlag(['--recover']), yes: getBooleanFlag(['--yes'])}
}

const toNumber = (value: number | string | null | undefined) => {
  return Number(value ?? 0)
}

const getStaleDirtyRefreshClaims = async () => {
  return getAppDatabaseService().queryJson<StaleDirtyRefreshClaimRow>(`
    SELECT
      project_id AS projectId,
      dirty_token AS dirtyToken,
      active_dirty_token AS activeDirtyToken,
      last_completed_dirty_token AS lastCompletedDirtyToken,
      lease_expires_at AS leaseExpiresAt,
      worker_id AS workerId
    FROM app.project_mart_refresh_state
    WHERE refresh_status = 'running'
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at < NOW()
      AND dirty_token > last_completed_dirty_token
    ORDER BY lease_expires_at ASC, project_id ASC
  `)
}

const getStaleDirtyMaterializationClaims = async () => {
  return getAppDatabaseService().queryJson<StaleDirtyMaterializationClaimRow>(`
    SELECT
      project_id AS projectId,
      source_kind AS sourceKind,
      target_dirty_token AS targetDirtyToken,
      inserted_row_count AS insertedRowCount,
      materialization_owner AS materializationOwner,
      lease_expires_at AS leaseExpiresAt
    FROM app.project_mart_dirty_materialization_state
    WHERE materialization_status = 'running'
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at < NOW()
    ORDER BY lease_expires_at ASC, target_dirty_token ASC, project_id ASC, source_kind ASC
  `)
}

const getStaleLargeRebuildClaims = async () => {
  return getAppDatabaseService().queryJson<StaleLargeRebuildClaimRow>(`
    SELECT
      project_id AS projectId,
      refresh_token AS refreshToken,
      rebuild_phase AS rebuildPhase,
      lease_expires_at AS leaseExpiresAt,
      worker_id AS workerId
    FROM app.project_mart_large_rebuild_state
    WHERE refresh_status = 'running'
      AND refresh_token > 0
      AND superseded_at IS NULL
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at < NOW()
    ORDER BY lease_expires_at ASC, refresh_token ASC, project_id ASC
  `)
}

const getQuarantineBarriers = async () => {
  return getAppDatabaseService().queryJson<QuarantineBarrierRow>(`
    SELECT
      project_id AS projectId,
      article_id AS articleId,
      dirty_token AS dirtyToken
    FROM app.project_mart_dirty_refresh_article_quarantine
    WHERE resolved_at IS NULL
    ORDER BY project_id ASC, dirty_token ASC, article_id ASC
  `)
}

const getDirtyRefreshSummary = (rows: StaleDirtyRefreshClaimRow[]) => {
  return rows.map((row) => {
    return {
      activeDirtyToken: toNumber(row.activeDirtyToken),
      dirtyToken: toNumber(row.dirtyToken),
      lastCompletedDirtyToken: toNumber(row.lastCompletedDirtyToken),
      leaseExpiresAt: row.leaseExpiresAt,
      projectId: row.projectId,
      workerId: row.workerId,
    }
  })
}

const getDirtyMaterializationSummary = (rows: StaleDirtyMaterializationClaimRow[]) => {
  return rows.map((row) => {
    return {
      insertedRowCount: toNumber(row.insertedRowCount),
      leaseExpiresAt: row.leaseExpiresAt,
      materializationOwner: row.materializationOwner,
      projectId: row.projectId,
      sourceKind: row.sourceKind,
      targetDirtyToken: toNumber(row.targetDirtyToken),
    }
  })
}

const getLargeRebuildSummary = (rows: StaleLargeRebuildClaimRow[]) => {
  return rows.map((row) => {
    return {
      leaseExpiresAt: row.leaseExpiresAt,
      projectId: row.projectId,
      rebuildPhase: row.rebuildPhase,
      refreshToken: toNumber(row.refreshToken),
      workerId: row.workerId,
    }
  })
}

const getQuarantineBarrierSummary = (rows: QuarantineBarrierRow[]) => {
  return rows.map((row) => {
    return {articleId: row.articleId, dirtyToken: toNumber(row.dirtyToken), projectId: row.projectId}
  })
}

const getUniqueProjectIds = (projectIds: string[]) => {
  return [...new Set(projectIds)].sort()
}

const queueV4RecoveryRequests = async (params: {projectIds: string[]; reason: string}): Promise<RecoveryResult[]> => {
  const projectIds = getUniqueProjectIds(params.projectIds)

  if (projectIds.length === 0) {
    return []
  }

  const requests = await requestReviewServingV4Rebuilds(
    projectIds.map((projectId) => {
      return {projectId, reason: params.reason}
    }),
  )

  return [
    {
      kind: 'v4_rebuild_request',
      projectIds,
      reason: params.reason,
      requestIds: requests.map((request) => {
        return request.requestId
      }),
    },
  ]
}

const recoverDirtyMaterializations = (rows: StaleDirtyMaterializationClaimRow[]) => {
  return queueV4RecoveryRequests({
    projectIds: rows.map((row) => {
      return row.projectId
    }),
    reason: 'recoverDirtyRefreshClaims.staleDirtyMaterialization',
  })
}

const recoverDirtyRefreshClaims = (rows: StaleDirtyRefreshClaimRow[]) => {
  return queueV4RecoveryRequests({
    projectIds: rows.map((row) => {
      return row.projectId
    }),
    reason: 'recoverDirtyRefreshClaims.staleDirtyRefreshClaim',
  })
}

const recoverLargeRebuildClaims = (rows: StaleLargeRebuildClaimRow[]) => {
  return queueV4RecoveryRequests({
    projectIds: rows.map((row) => {
      return row.projectId
    }),
    reason: 'recoverDirtyRefreshClaims.staleLargeRebuildClaim',
  })
}

export const recoverDirtyRefreshClaimState = async () => {
  const options = getCliOptions()

  try {
    const [dirtyRefreshClaims, dirtyMaterializations, largeRebuildClaims, quarantineBarriers] = await Promise.all([
      getStaleDirtyRefreshClaims(),
      getStaleDirtyMaterializationClaims(),
      getStaleLargeRebuildClaims(),
      getQuarantineBarriers(),
    ])
    const staleClaims = getDirtyRefreshSummary(dirtyRefreshClaims)
    const staleDirtyMaterializations = getDirtyMaterializationSummary(dirtyMaterializations)
    const staleLargeRebuildClaims = getLargeRebuildSummary(largeRebuildClaims)
    const unresolvedQuarantineBarriers = getQuarantineBarrierSummary(quarantineBarriers)

    if (!options.recover) {
      console.log(
        JSON.stringify({
          recoverAttempted: false,
          staleClaims,
          staleDirtyMaterializations,
          staleLargeRebuildClaims,
          status: 'listed',
          unresolvedQuarantineBarriers,
        }),
      )
      return
    }

    if (!options.yes) {
      throw new Error('Refusing recovery without --yes')
    }

    const recoveryResults = [
      ...(await recoverDirtyMaterializations(dirtyMaterializations)),
      ...(await recoverDirtyRefreshClaims(dirtyRefreshClaims)),
      ...(await recoverLargeRebuildClaims(largeRebuildClaims)),
    ]

    console.log(
      JSON.stringify({
        recoverAttempted: true,
        recoveryResult: recoveryResults[0] ?? null,
        recoveryResults,
        staleClaims,
        staleDirtyMaterializations,
        staleLargeRebuildClaims,
        status: 'recovered',
        unresolvedQuarantineBarriers,
      }),
    )
  } finally {
    await getAppDatabaseService().close()
  }
}

if (import.meta.main) {
  await recoverDirtyRefreshClaimState()
}
