import {
  type ProjectTransferStalePlanReasons,
  type ProjectTransferStalePlanReasonSurface,
  projectTransferStalePlanReasonSurfaces,
} from './projectTransferContracts.ts'
import {
  getCompleteProjectTransferTargetStateTableWrites,
  getProjectTransferTargetStateTableWrites,
  isProjectTransferTargetStateCoverageComplete,
  projectTransferDependencyFingerprintAlgorithm,
  projectTransferDependencyFingerprintCodeVersion,
  projectTransferTargetStateCoverageCodeVersion,
  type ProjectTransferTargetStateDirtyTokenSnapshot,
  type ProjectTransferTargetStateSafetySurface,
  projectTransferTargetStateSafetySurfaces,
  projectTransferTargetStateTablesBySurface,
  type ProjectTransferTargetStateTableWriteSnapshot,
} from './projectTransferTargetStateDirtyTokenService.ts'

export type ProjectTransferDirtyTokenFullRevalidationReason =
  | 'analyzed_target_state_missing'
  | 'analyzed_target_state_coverage_incomplete'
  | 'current_target_state_missing'
  | 'current_target_state_coverage_incomplete'
  | 'target_state_coverage_version_changed'
  | 'target_state_dependency_fingerprint_version_changed'
  | 'target_state_global_unknown_token_changed'
  | 'target_state_dirty_token_changed'
  | 'target_state_dirty_token_missing'
  | 'target_state_table_write_epoch_changed'
  | 'target_state_table_write_changed'
  | 'incremental_revalidation_disabled'

export type ProjectTransferDirtyTokenRevalidationDecision =
  | {
      changedSurfaces: ProjectTransferTargetStateSafetySurface[]
      eligible: false
      reason: ProjectTransferDirtyTokenFullRevalidationReason
      status: 'full_revalidation_required'
    }
  | {changedSurfaces: []; eligible: true; reason: 'target_state_unchanged'; status: 'incremental_revalidation_allowed'}

type ProjectTransferDirtyTokenRevalidationInput = {
  analyzedTargetState?: ProjectTransferTargetStateDirtyTokenSnapshot | null
  currentTargetState?: ProjectTransferTargetStateDirtyTokenSnapshot | null
  enableIncrementalRevalidation?: boolean
}

const projectTransferAllStalePlanReasonSurfaces = [...projectTransferStalePlanReasonSurfaces]

const projectTransferDirtyTokenStalePlanSurfaceByTargetStateSurface = {
  article: ['targetArticle'],
  articleIdentifier: ['targetArticle'],
  humanJudgment: ['humanReview'],
  humanJudgmentSummary: ['humanReview'],
  importedSnapshotMarker: ['dependency'],
  importRoute: ['targetRoute'],
  judgment: ['judgment'],
  judgmentAssessment: ['assessment'],
  model: ['dependency'],
  project: ['targetProject'],
  projectArticle: ['targetArticle'],
  projectImportRoute: ['targetRoute'],
  projectPrompt: ['targetPrompt'],
  projectTransferHistory: ['duplicatePackageHistory'],
  prompt: ['targetPrompt'],
  providerConnection: ['dependency'],
  review: ['humanReview'],
  snapshotFingerprintInput: ['dependency'],
} as const satisfies Record<ProjectTransferTargetStateSafetySurface, readonly ProjectTransferStalePlanReasonSurface[]>

const projectTransferAllSurfaceFallbackReasons = new Set<ProjectTransferDirtyTokenFullRevalidationReason>([
  'analyzed_target_state_missing',
  'analyzed_target_state_coverage_incomplete',
  'current_target_state_missing',
  'current_target_state_coverage_incomplete',
  'target_state_coverage_version_changed',
  'target_state_global_unknown_token_changed',
  'target_state_table_write_epoch_changed',
])

const projectTransferDependencySurfaceFallbackReasons = new Set<ProjectTransferDirtyTokenFullRevalidationReason>([
  'target_state_dependency_fingerprint_version_changed',
])

const getFullRevalidationDecision = (
  reason: ProjectTransferDirtyTokenFullRevalidationReason,
  changedSurfaces: ProjectTransferTargetStateSafetySurface[] = [],
): ProjectTransferDirtyTokenRevalidationDecision => {
  return {changedSurfaces, eligible: false, reason, status: 'full_revalidation_required'}
}

const getMissingTokenSurfaces = (
  analyzed: ProjectTransferTargetStateDirtyTokenSnapshot,
  current: ProjectTransferTargetStateDirtyTokenSnapshot,
) => {
  return projectTransferTargetStateSafetySurfaces.filter((surface) => {
    return typeof analyzed.tokens[surface] !== 'number' || typeof current.tokens[surface] !== 'number'
  })
}

const getChangedTokenSurfaces = (
  analyzed: ProjectTransferTargetStateDirtyTokenSnapshot,
  current: ProjectTransferTargetStateDirtyTokenSnapshot,
) => {
  return projectTransferTargetStateSafetySurfaces.filter((surface) => {
    return analyzed.tokens[surface] !== current.tokens[surface]
  })
}

const getTableWriteCounters = (snapshot: ProjectTransferTargetStateDirtyTokenSnapshot) => {
  return getProjectTransferTargetStateTableWrites(snapshot)?.counters ?? {}
}

const tableWriteEpochChanged = (
  analyzed: ProjectTransferTargetStateDirtyTokenSnapshot,
  current: ProjectTransferTargetStateDirtyTokenSnapshot,
) => {
  const analyzedEpoch = getProjectTransferTargetStateTableWrites(analyzed)?.epoch

  return analyzedEpoch === undefined || analyzedEpoch !== getProjectTransferTargetStateTableWrites(current)?.epoch
}

const getChangedTableWriteSurfaces = (
  analyzed: ProjectTransferTargetStateDirtyTokenSnapshot,
  current: ProjectTransferTargetStateDirtyTokenSnapshot,
) => {
  const analyzedCounters = getTableWriteCounters(analyzed)
  const currentCounters = getTableWriteCounters(current)

  return projectTransferTargetStateSafetySurfaces.filter((surface) => {
    return projectTransferTargetStateTablesBySurface[surface].some((table) => {
      return typeof analyzedCounters[table] !== 'number' || analyzedCounters[table] !== currentCounters[table]
    })
  })
}

const dependencyFingerprintVersionChanged = (
  analyzed: ProjectTransferTargetStateDirtyTokenSnapshot,
  current: ProjectTransferTargetStateDirtyTokenSnapshot,
) => {
  return (
    analyzed.coverage?.dependencyFingerprintAlgorithm !== current.coverage?.dependencyFingerprintAlgorithm
    || analyzed.coverage?.dependencyFingerprintCodeVersion !== current.coverage?.dependencyFingerprintCodeVersion
    || current.coverage?.dependencyFingerprintAlgorithm !== projectTransferDependencyFingerprintAlgorithm
    || current.coverage?.dependencyFingerprintCodeVersion !== projectTransferDependencyFingerprintCodeVersion
  )
}

export const getProjectTransferDirtyTokenRevalidationDecision = ({
  analyzedTargetState,
  currentTargetState,
  enableIncrementalRevalidation = true,
}: ProjectTransferDirtyTokenRevalidationInput): ProjectTransferDirtyTokenRevalidationDecision => {
  if (analyzedTargetState === null || analyzedTargetState === undefined) {
    return getFullRevalidationDecision('analyzed_target_state_missing')
  }

  if (currentTargetState === null || currentTargetState === undefined) {
    return getFullRevalidationDecision('current_target_state_missing')
  }

  if (!isProjectTransferTargetStateCoverageComplete(analyzedTargetState)) {
    return getFullRevalidationDecision('analyzed_target_state_coverage_incomplete')
  }

  if (!isProjectTransferTargetStateCoverageComplete(currentTargetState)) {
    return getFullRevalidationDecision('current_target_state_coverage_incomplete')
  }

  if (
    analyzedTargetState.coverage?.coverageCodeVersion !== currentTargetState.coverage?.coverageCodeVersion
    || currentTargetState.coverage?.coverageCodeVersion !== projectTransferTargetStateCoverageCodeVersion
  ) {
    return getFullRevalidationDecision('target_state_coverage_version_changed')
  }

  if (dependencyFingerprintVersionChanged(analyzedTargetState, currentTargetState)) {
    return getFullRevalidationDecision('target_state_dependency_fingerprint_version_changed')
  }

  if (analyzedTargetState.globalUnknownToken !== currentTargetState.globalUnknownToken) {
    return getFullRevalidationDecision('target_state_global_unknown_token_changed')
  }

  const missingTokenSurfaces = getMissingTokenSurfaces(analyzedTargetState, currentTargetState)

  if (missingTokenSurfaces.length > 0) {
    return getFullRevalidationDecision('target_state_dirty_token_missing', missingTokenSurfaces)
  }

  const changedTokenSurfaces = getChangedTokenSurfaces(analyzedTargetState, currentTargetState)

  if (changedTokenSurfaces.length > 0) {
    return getFullRevalidationDecision('target_state_dirty_token_changed', changedTokenSurfaces)
  }

  if (tableWriteEpochChanged(analyzedTargetState, currentTargetState)) {
    return getFullRevalidationDecision('target_state_table_write_epoch_changed')
  }

  const changedTableWriteSurfaces = getChangedTableWriteSurfaces(analyzedTargetState, currentTargetState)

  if (changedTableWriteSurfaces.length > 0) {
    return getFullRevalidationDecision('target_state_table_write_changed', changedTableWriteSurfaces)
  }

  return enableIncrementalRevalidation
    ? {
        changedSurfaces: [],
        eligible: true,
        reason: 'target_state_unchanged',
        status: 'incremental_revalidation_allowed',
      }
    : getFullRevalidationDecision('incremental_revalidation_disabled')
}

const getReasonSurfaces = (decision: ProjectTransferDirtyTokenRevalidationDecision) => {
  return decision.eligible
    ? []
    : projectTransferAllSurfaceFallbackReasons.has(decision.reason)
      ? projectTransferAllStalePlanReasonSurfaces
      : projectTransferDependencySurfaceFallbackReasons.has(decision.reason)
        ? (['dependency', 'judgment', 'assessment', 'humanReview'] as const)
        : decision.changedSurfaces.flatMap((surface) => {
            return projectTransferDirtyTokenStalePlanSurfaceByTargetStateSurface[surface]
          })
}

export const getProjectTransferDirtyTokenStalePlanReasons = (
  decision: ProjectTransferDirtyTokenRevalidationDecision,
): ProjectTransferStalePlanReasons => {
  const reasonSurfaces = Array.from(new Set(getReasonSurfaces(decision)))

  return decision.eligible
    ? {}
    : reasonSurfaces.reduce<ProjectTransferStalePlanReasons>((reasons, surface) => {
        return {...reasons, [surface]: [{reason: decision.reason, targetStateSurfaces: decision.changedSurfaces}]}
      }, {})
}

export type ProjectTransferCommitWriteGuardDecision =
  | {reason: 'current_table_writes_unavailable' | 'planned_table_writes_unavailable'; status: 'skipped'}
  | {decision: ProjectTransferDirtyTokenRevalidationDecision; status: 'changed'}
  | {status: 'unchanged'}

const getStatementTableWriteCount = (tableWrites: ProjectTransferTargetStateTableWriteSnapshot, table: string) => {
  const externalCount = tableWrites.externalCounters?.[table]

  return (tableWrites.counters[table] ?? 0) - (Number.isSafeInteger(externalCount) ? Number(externalCount) : 0)
}

const getChangedStatementWriteSurfaces = (
  planned: ProjectTransferTargetStateTableWriteSnapshot,
  current: ProjectTransferTargetStateTableWriteSnapshot,
) => {
  return projectTransferTargetStateSafetySurfaces.filter((surface) => {
    return projectTransferTargetStateTablesBySurface[surface].some((table) => {
      return getStatementTableWriteCount(planned, table) !== getStatementTableWriteCount(current, table)
    })
  })
}

const getCommitWriteGuardChangedDecision = (
  reason: 'target_state_table_write_changed' | 'target_state_table_write_epoch_changed',
  changedSurfaces: ProjectTransferTargetStateSafetySurface[],
): ProjectTransferCommitWriteGuardDecision => {
  return {decision: getFullRevalidationDecision(reason, changedSurfaces), status: 'changed'}
}

const getCommitWriteGuardTableDecision = (
  planned: ProjectTransferTargetStateTableWriteSnapshot,
  current: ProjectTransferTargetStateTableWriteSnapshot,
): ProjectTransferCommitWriteGuardDecision => {
  const changedSurfaces = getChangedStatementWriteSurfaces(planned, current)

  return changedSurfaces.length === 0
    ? {status: 'unchanged'}
    : getCommitWriteGuardChangedDecision('target_state_table_write_changed', changedSurfaces)
}

export const getProjectTransferCommitWriteGuardDecision = ({
  currentTableWrites,
  plannedTargetState,
}: {
  currentTableWrites: unknown
  plannedTargetState?: ProjectTransferTargetStateDirtyTokenSnapshot | null
}): ProjectTransferCommitWriteGuardDecision => {
  const planned =
    plannedTargetState === null || plannedTargetState === undefined
      ? null
      : getProjectTransferTargetStateTableWrites(plannedTargetState)
  const current = getCompleteProjectTransferTargetStateTableWrites(currentTableWrites)

  if (planned === null) {
    return {reason: 'planned_table_writes_unavailable', status: 'skipped'}
  }

  if (current === null) {
    return {reason: 'current_table_writes_unavailable', status: 'skipped'}
  }

  return planned.epoch === current.epoch
    ? getCommitWriteGuardTableDecision(planned, current)
    : getCommitWriteGuardChangedDecision('target_state_table_write_epoch_changed', [])
}
