import type {ProjectTransferImportPlanArtifact} from '../../services/projectTransfer/projectTransferAnalyze.ts'
import type {ProjectTransferSessionResponse} from '../../services/projectTransfer/projectTransferContracts.ts'
import {validateProjectTransferReviewedPlanStagingRevision} from '../../services/projectTransfer/projectTransferStaging.ts'

export const validateCurrentImportPlanArtifact = (
  response: ProjectTransferSessionResponse,
  plan: ProjectTransferImportPlanArtifact | null,
) => {
  if (plan === null) {
    return {error: 'Project transfer import plan artifact is unavailable', ok: false as const}
  }

  return validateProjectTransferReviewedPlanStagingRevision({plan, progress: response.progress})
}
