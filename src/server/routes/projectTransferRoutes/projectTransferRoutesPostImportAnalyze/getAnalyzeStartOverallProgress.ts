import {getProjectTransferOverallProgress} from '../../../services/projectTransfer/projectTransferProgressWeights.ts'

export const getAnalyzeStartOverallProgress = () => {
  return getProjectTransferOverallProgress({operation: 'analyze', step: 'zipScan', stepFraction: 0})
}
