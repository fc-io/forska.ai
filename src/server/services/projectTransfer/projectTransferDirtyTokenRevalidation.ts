import {
  isProjectTransferTargetStateCoverageComplete,
  projectTransferDependencyFingerprintAlgorithm,
  projectTransferDependencyFingerprintCodeVersion,
  projectTransferTargetStateCoverageCodeVersion,
  type ProjectTransferTargetStateDirtyTokenSnapshot,
  type ProjectTransferTargetStateSafetySurface,
  projectTransferTargetStateSafetySurfaces,
} from './projectTransferTargetStateDirtyTokenService.ts'

export type ProjectTransferDirtyTokenFullRevalidationReason =
  | 'analyzed_target_state_missing'
  | 'analyzed_target_state_coverage_incomplete'
  | 'current_target_state_coverage_incomplete'
  | 'target_state_coverage_version_changed'
  | 'target_state_dependency_fingerprint_version_changed'
  | 'target_state_global_unknown_token_changed'
  | 'target_state_dirty_token_changed'
  | 'target_state_dirty_token_missing'
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
  currentTargetState: ProjectTransferTargetStateDirtyTokenSnapshot
  enableIncrementalRevalidation?: boolean
}

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
  enableIncrementalRevalidation = false,
}: ProjectTransferDirtyTokenRevalidationInput): ProjectTransferDirtyTokenRevalidationDecision => {
  if (analyzedTargetState === null || analyzedTargetState === undefined) {
    return getFullRevalidationDecision('analyzed_target_state_missing')
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

  return enableIncrementalRevalidation
    ? {
        changedSurfaces: [],
        eligible: true,
        reason: 'target_state_unchanged',
        status: 'incremental_revalidation_allowed',
      }
    : getFullRevalidationDecision('incremental_revalidation_disabled')
}
