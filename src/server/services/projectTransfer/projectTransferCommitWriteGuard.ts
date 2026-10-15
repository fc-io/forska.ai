import {writeRuntimeOperatorLogEvent} from '../../utils/runtimeLogger.ts'
import type {ProjectTransferImportPlanArtifact} from './projectTransferAnalyze.ts'
import {
  getProjectTransferCommitWriteGuardDecision,
  type ProjectTransferCommitWriteGuardDecision,
  type ProjectTransferDirtyTokenRevalidationDecision,
} from './projectTransferDirtyTokenRevalidation.ts'
import {getCurrentProjectTransferTargetStateTableWrites} from './projectTransferTargetStateDirtyTokenService.ts'

const projectTransferCommitTargetStateChangedErrorCode = 'project_transfer_commit_target_state_changed'

export type ProjectTransferCommitTargetStateChangedError = Error & {
  code: typeof projectTransferCommitTargetStateChangedErrorCode
  decision: ProjectTransferDirtyTokenRevalidationDecision
}

export const isProjectTransferCommitTargetStateChangedError = (
  error: unknown,
): error is ProjectTransferCommitTargetStateChangedError => {
  return (
    error instanceof Error
    && (error as Partial<ProjectTransferCommitTargetStateChangedError>).code
      === projectTransferCommitTargetStateChangedErrorCode
  )
}

const getProjectTransferCommitTargetStateChangedError = (
  decision: ProjectTransferDirtyTokenRevalidationDecision,
): ProjectTransferCommitTargetStateChangedError => {
  const surfaces = decision.changedSurfaces.length === 0 ? 'all surfaces' : decision.changedSurfaces.join(', ')

  return Object.assign(
    new Error(
      `Project transfer commit: target project data changed after revalidation (${decision.reason}: ${surfaces}); nothing was written`,
    ),
    {code: projectTransferCommitTargetStateChangedErrorCode, decision} as const,
  )
}

const writeCommitWriteGuardLogEvent = ({
  guard,
  sessionId,
}: {
  guard: Exclude<ProjectTransferCommitWriteGuardDecision, {status: 'unchanged'}>
  sessionId: string
}) => {
  writeRuntimeOperatorLogEvent({
    attrs: {
      changedSurfaces: guard.status === 'changed' ? guard.decision.changedSurfaces : [],
      reason: guard.status === 'changed' ? guard.decision.reason : guard.reason,
      sessionId,
      status: guard.status,
    },
    event: 'project_transfer.commit_target_state_guard',
    message:
      guard.status === 'changed'
        ? 'Project transfer commit stopped before writing because tracked target tables changed after revalidation'
        : 'Project transfer commit wrote without the target-state guard because table-write tracking was unavailable',
    severity: guard.status === 'changed' ? 'WARN' : 'INFO',
  })
}

export const assertProjectTransferCommitTargetStateUnchanged = ({
  plan,
  sessionId,
}: {
  plan: Pick<ProjectTransferImportPlanArtifact, 'targetState'>
  sessionId: string
}) => {
  const guard = getProjectTransferCommitWriteGuardDecision({
    currentTableWrites: getCurrentProjectTransferTargetStateTableWrites(),
    plannedTargetState: plan.targetState,
  })

  if (guard.status !== 'unchanged') {
    writeCommitWriteGuardLogEvent({guard, sessionId})
  }

  if (guard.status === 'changed') {
    throw getProjectTransferCommitTargetStateChangedError(guard.decision)
  }

  return guard
}
