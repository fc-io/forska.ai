import {enqueueCompletionTokenUse} from '../../../cron/judgmentsJobs/judgmentCompletionTokenUseOutbox.ts'
import {
  getJudgmentJobSqliteService,
  JudgmentPromptClaimIdentityError,
} from '../../../cron/judgmentsJobs/judgmentJobSqliteService.ts'
import {getLegacyFullTextStrategyId} from '../../../fullText/fullTextStrategy.ts'
import {isJudgmentExecutionSnapshotIdentityValid} from '../../../services/judgmentExecutionSnapshotService.ts'
import {HttpError} from '../../../utils/httpError.ts'
import type {JudgmentCompletionBody, JudgmentCompletionIdentity} from './judgmentCompletionTypes.ts'

export const assertCompletionSnapshotIdentity = async (identity: JudgmentCompletionIdentity) => {
  const snapshotValid = await isJudgmentExecutionSnapshotIdentityValid(identity)

  if (!snapshotValid) {
    throw new HttpError(409, 'snapshot identity mismatch for judgment completion')
  }
}

export const assertCompletionClaimIdentity = async (
  identity: JudgmentCompletionIdentity,
  options: {allowUnclaimedReadyPrompt?: boolean} = {},
) => {
  try {
    return await getJudgmentJobSqliteService().assertPromptClaimIdentityMatch(identity, options)
  } catch (error) {
    if (error instanceof JudgmentPromptClaimIdentityError) {
      throw new HttpError(409, error.message)
    }

    throw error
  }
}

export const getCompletionIdentity = (jobId: string, body: JudgmentCompletionBody): JudgmentCompletionIdentity => {
  return {
    ...body,
    fullTextStrategyId:
      body.fullTextStrategyId
      ?? getLegacyFullTextStrategyId({useFulltext: body.useFulltext, useFulltextNoImages: body.useFulltextNoImages}),
    jobId,
    useMetadata: body.useMetadata === true,
  }
}

export const getExistingCompletionAckResponse = async (jobId: string, body: JudgmentCompletionBody) => {
  const existingAck = await getJudgmentJobSqliteService().getPromptCompletionAck(jobId, body.claimId)

  if (!existingAck) {
    return null
  }

  const snapshotValid = await isJudgmentExecutionSnapshotIdentityValid(getCompletionIdentity(jobId, body))

  if (!snapshotValid || existingAck.queuePromptId !== body.queueRecordId) {
    throw new HttpError(409, 'snapshot identity mismatch for replayed judgment completion')
  }

  await enqueueCompletionTokenUse(body)

  return {
    data: {claimId: body.claimId, queueRecordId: existingAck.queuePromptId, status: existingAck.status},
    error: null,
  }
}
