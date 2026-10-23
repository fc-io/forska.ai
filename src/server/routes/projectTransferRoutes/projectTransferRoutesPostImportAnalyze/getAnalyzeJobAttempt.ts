import {rm} from 'node:fs/promises'

import {resolveProjectTransferTempWritablePath} from '../../../services/projectTransfer/projectTransferPaths.ts'
import {
  getProjectTransferImportTempLayout,
  toProjectTransferSessionResponse,
} from '../../../services/projectTransfer/projectTransferSession.ts'
import {getProjectTransferSessionRepository} from '../../../services/projectTransfer/projectTransferSessionRepository.ts'
import {getAnalyzeProgress} from '../getAnalyzeProgress.ts'
import {getErrorPayload} from '../getErrorPayload.ts'
import {getUploadMetadataFromProgress} from '../getUploadMetadataFromProgress.ts'
import {runProjectTransferImportAnalyzeJob} from './getAnalyzeJobAttempt/runProjectTransferImportAnalyzeJob.ts'

const failProjectTransferImportAnalyzeSession = async ({
  error,
  ownerToken,
  sessionId,
}: {
  error: unknown
  ownerToken: string
  sessionId: string
}) => {
  const repository = getProjectTransferSessionRepository()
  const current = await repository.getProjectTransferSession({sessionId})
  const currentProgress = current === null ? null : toProjectTransferSessionResponse(current).progress
  const upload = getUploadMetadataFromProgress(currentProgress)

  const failed = await repository.transitionProjectTransferSessionState({
    error: getErrorPayload(error),
    expectedOwnerToken: ownerToken,
    expectedState: ['extracting', 'analyzing'],
    nextOwnerToken: null,
    nextState: 'failed',
    progress: getAnalyzeProgress({
      now: new Date(),
      overall: currentProgress?.overall,
      phase: 'analyze',
      status: 'failed',
      upload,
    }),
    sessionId,
  })

  if (failed !== null) {
    const progressPath = resolveProjectTransferTempWritablePath({
      pathValue: getProjectTransferImportTempLayout(sessionId).progressPath,
    })
    await rm(progressPath, {force: true}).catch(() => {
      return undefined
    })
  }

  return failed
}

export const getAnalyzeJobAttempt = async (params: {ownerToken: string; sessionId: string}) => {
  try {
    return await runProjectTransferImportAnalyzeJob(params)
  } catch (error) {
    await failProjectTransferImportAnalyzeSession({...params, error})
    throw error
  }
}
