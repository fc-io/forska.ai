import type {ProjectTransferProgressPayload} from '../../../services/projectTransfer/projectTransferContracts.ts'
import {getProjectTransferOverallProgress} from '../../../services/projectTransfer/projectTransferProgressWeights.ts'

export const getDependencyResolutionOverallProgress = (
  previousProgress: ProjectTransferProgressPayload | null,
  stepFraction: number,
) => {
  return getProjectTransferOverallProgress({
    operation: 'analyze',
    previousPercent: previousProgress?.overall?.operation === 'analyze' ? previousProgress.overall.percent : 0,
    step: 'dependencies',
    stepFraction,
  })
}
