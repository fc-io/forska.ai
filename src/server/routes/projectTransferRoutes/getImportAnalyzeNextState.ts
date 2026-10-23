import {
  type ProjectTransferPlanSummary,
  validateProjectTransferPlanReadyToCommit,
} from '../../services/projectTransfer/projectTransferContracts.ts'

export const getImportAnalyzeNextState = (planSummary: ProjectTransferPlanSummary) => {
  return validateProjectTransferPlanReadyToCommit(planSummary).ok ? 'ready_to_commit' : 'awaiting_resolution'
}
