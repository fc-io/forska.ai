import {runWithProjectTransferBackgroundActivity} from '../../../services/projectTransfer/projectTransferBackgroundActivity.ts'
import {getAnalyzeJobAttempt} from './getAnalyzeJobAttempt.ts'

export const startBackgroundAnalyzeJob = (params: {ownerToken: string; sessionId: string}) => {
  queueMicrotask(() => {
    void runWithProjectTransferBackgroundActivity(() => {
      return getAnalyzeJobAttempt(params)
    }).catch((error) => {
      console.error('Project transfer import analyze job failed', error)
    })
  })
}
