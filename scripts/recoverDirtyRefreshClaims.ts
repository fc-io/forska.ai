import {requestReviewServingV4Rebuild} from '../src/server/reviewServing/reviewServingV4RebuildRequestService.ts'
import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {getSqlLiteral} from '../src/server/services/appQueryHelpers.ts'

type CliOptions = {recover: boolean; yes: boolean}

type RecoveryFailure = {error: string; projectId: string}
type RecoveryRequestResult = {failedProjects: RecoveryFailure[]; projectIds: string[]; requestIds: string[]}
type RecoveryResult = {
  failedCount: number
  failedProjects: RecoveryFailure[]
  kind: 'v4_rebuild_request'
  projectIds: string[]
  reason: string
  requestIds: string[]
}

const staleLegacyClaimRecoveryReason = 'recoverDirtyRefreshClaims.staleLegacyClaim'

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

const getIntegerSqlLiteral = (value: number | string) => {
  const numberValue = Number(value)

  return Number.isFinite(numberValue) ? String(Math.trunc(numberValue)) : '0'
}

const getRecoveredClaimSqlValues = (rows: StaleDirtyRefreshClaimRow[]) => {
  return rows
    .map((row) => {
      return `(${getSqlLiteral(row.projectId)}, ${getIntegerSqlLiteral(row.dirtyToken)}, ${getIntegerSqlLiteral(row.activeDirtyToken)})`
    })
    .join(', ')
}

const getRecoveredDirtyMaterializationSqlValues = (rows: StaleDirtyMaterializationClaimRow[]) => {
  return rows
    .map((row) => {
      return `(${getSqlLiteral(row.projectId)}, ${getSqlLiteral(row.sourceKind)}, ${getIntegerSqlLiteral(row.targetDirtyToken)})`
    })
    .join(', ')
}

const getRecoveredLargeRebuildSqlValues = (rows: StaleLargeRebuildClaimRow[]) => {
  return rows
    .map((row) => {
      return `(${getSqlLiteral(row.projectId)}, ${getIntegerSqlLiteral(row.refreshToken)}, ${getSqlLiteral(row.rebuildPhase)})`
    })
    .join(', ')
}

const getFailureMessage = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  const details = String(error)
  const rebuildChunkMessage = details.match(/Review rebuild request [^\n]+ created no rebuild chunks/u)?.[0]

  return rebuildChunkMessage ?? message
}

const requestProjectRecovery = async (
  input: {projectIds: string[]; reason: string},
  index = 0,
): Promise<RecoveryRequestResult> => {
  const projectId = input.projectIds[index]

  if (!projectId) {
    return {failedProjects: [], projectIds: [], requestIds: []}
  }

  try {
    const request = await requestReviewServingV4Rebuild({projectId, reason: input.reason})
    const remaining = await requestProjectRecovery(input, index + 1)

    return {
      failedProjects: remaining.failedProjects,
      projectIds: [projectId, ...remaining.projectIds],
      requestIds: [request.requestId, ...remaining.requestIds],
    }
  } catch (error) {
    const failure = {error: getFailureMessage(error), projectId}
    const remaining = await requestProjectRecovery(input, index + 1)

    return {
      failedProjects: [failure, ...remaining.failedProjects],
      projectIds: remaining.projectIds,
      requestIds: remaining.requestIds,
    }
  }
}

const queueV4RecoveryRequests = async (params: {projectIds: string[]; reason: string}): Promise<RecoveryResult[]> => {
  const projectIds = getUniqueProjectIds(params.projectIds)

  if (projectIds.length === 0) {
    return []
  }

  const result = await requestProjectRecovery({projectIds, reason: params.reason})

  return [
    {
      failedCount: result.failedProjects.length,
      failedProjects: result.failedProjects,
      kind: 'v4_rebuild_request',
      projectIds: result.projectIds,
      reason: params.reason,
      requestIds: result.requestIds,
    },
  ]
}

const getRowsForProjects = <TRow extends {projectId: string}>(rows: TRow[], projectIds: readonly string[]) => {
  const projectIdSet = new Set(projectIds)

  return rows.filter((row) => {
    return projectIdSet.has(row.projectId)
  })
}

const releaseStaleDirtyRefreshClaims = async (rows: StaleDirtyRefreshClaimRow[]) => {
  if (rows.length === 0) {
    return
  }

  await getAppDatabaseService().run(`
    UPDATE app.project_mart_refresh_state
    SET
      active_dirty_token = 0,
      last_completed_dirty_token = dirty_token,
      refresh_status = 'idle',
      last_completed_at = current_timestamp,
      last_error = NULL,
      worker_id = NULL,
      lease_expires_at = NULL,
      updated_at = current_timestamp
    WHERE EXISTS (
        SELECT 1
        FROM (VALUES ${getRecoveredClaimSqlValues(rows)}) AS recovered_claim(project_id, dirty_token, active_dirty_token)
        WHERE recovered_claim.project_id = app.project_mart_refresh_state.project_id
          AND recovered_claim.dirty_token = app.project_mart_refresh_state.dirty_token
          AND recovered_claim.active_dirty_token = app.project_mart_refresh_state.active_dirty_token
      )
      AND refresh_status = 'running'
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at < NOW()
      AND dirty_token > last_completed_dirty_token
  `)
}

const releaseStaleDirtyMaterializationClaims = async (rows: StaleDirtyMaterializationClaimRow[]) => {
  if (rows.length === 0) {
    return
  }

  await getAppDatabaseService().run(`
    UPDATE app.project_mart_dirty_materialization_state
    SET
      materialization_status = 'completed',
      materialization_owner = NULL,
      lease_expires_at = NULL,
      last_completed_at = current_timestamp,
      last_error = NULL,
      updated_at = current_timestamp
    WHERE EXISTS (
        SELECT 1
        FROM (VALUES ${getRecoveredDirtyMaterializationSqlValues(rows)}) AS recovered_claim(project_id, source_kind, target_dirty_token)
        WHERE recovered_claim.project_id = app.project_mart_dirty_materialization_state.project_id
          AND recovered_claim.source_kind = app.project_mart_dirty_materialization_state.source_kind
          AND recovered_claim.target_dirty_token = app.project_mart_dirty_materialization_state.target_dirty_token
      )
      AND materialization_status = 'running'
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at < NOW()
  `)
}

const releaseStaleLargeRebuildClaims = async (rows: StaleLargeRebuildClaimRow[]) => {
  if (rows.length === 0) {
    return
  }

  await getAppDatabaseService().run(`
    UPDATE app.project_mart_large_rebuild_state
    SET
      refresh_status = 'idle',
      worker_id = NULL,
      lease_expires_at = NULL,
      superseded_at = current_timestamp,
      last_completed_at = current_timestamp,
      last_error = NULL,
      updated_at = current_timestamp
    WHERE EXISTS (
        SELECT 1
        FROM (VALUES ${getRecoveredLargeRebuildSqlValues(rows)}) AS recovered_claim(project_id, refresh_token, rebuild_phase)
        WHERE recovered_claim.project_id = app.project_mart_large_rebuild_state.project_id
          AND recovered_claim.refresh_token = app.project_mart_large_rebuild_state.refresh_token
          AND recovered_claim.rebuild_phase = app.project_mart_large_rebuild_state.rebuild_phase
      )
      AND refresh_status = 'running'
      AND refresh_token > 0
      AND superseded_at IS NULL
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at < NOW()
  `)
}

const getStaleLegacyClaimProjectIds = (input: {
  dirtyMaterializations: StaleDirtyMaterializationClaimRow[]
  dirtyRefreshClaims: StaleDirtyRefreshClaimRow[]
  largeRebuildClaims: StaleLargeRebuildClaimRow[]
}) => {
  return getUniqueProjectIds([
    ...input.dirtyMaterializations.map((row) => {
      return row.projectId
    }),
    ...input.dirtyRefreshClaims.map((row) => {
      return row.projectId
    }),
    ...input.largeRebuildClaims.map((row) => {
      return row.projectId
    }),
  ])
}

const recoverStaleLegacyClaims = async (input: {
  dirtyMaterializations: StaleDirtyMaterializationClaimRow[]
  dirtyRefreshClaims: StaleDirtyRefreshClaimRow[]
  largeRebuildClaims: StaleLargeRebuildClaimRow[]
}) => {
  const recoveryResults = await queueV4RecoveryRequests({
    projectIds: getStaleLegacyClaimProjectIds(input),
    reason: staleLegacyClaimRecoveryReason,
  })
  const recoveredProjectIds = recoveryResults.flatMap((result) => {
    return result.projectIds
  })

  await releaseStaleDirtyMaterializationClaims(getRowsForProjects(input.dirtyMaterializations, recoveredProjectIds))
  await releaseStaleDirtyRefreshClaims(getRowsForProjects(input.dirtyRefreshClaims, recoveredProjectIds))
  await releaseStaleLargeRebuildClaims(getRowsForProjects(input.largeRebuildClaims, recoveredProjectIds))

  return recoveryResults
}

const getRecoveryStatus = (recoveryResults: RecoveryResult[]) => {
  const failedCount = recoveryResults.reduce((total, result) => {
    return total + result.failedCount
  }, 0)
  const requestCount = recoveryResults.reduce((total, result) => {
    return total + result.requestIds.length
  }, 0)

  return failedCount === 0 ? 'recovered' : requestCount === 0 ? 'failed' : 'recovered_with_failures'
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

    const recoveryResults = await recoverStaleLegacyClaims({
      dirtyMaterializations,
      dirtyRefreshClaims,
      largeRebuildClaims,
    })

    console.log(
      JSON.stringify({
        recoverAttempted: true,
        recoveryResult: recoveryResults[0] ?? null,
        recoveryResults,
        staleClaims,
        staleDirtyMaterializations,
        staleLargeRebuildClaims,
        status: getRecoveryStatus(recoveryResults),
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
