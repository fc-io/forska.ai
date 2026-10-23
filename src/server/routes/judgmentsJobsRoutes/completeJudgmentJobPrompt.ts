import {
  enqueueCompletionTokenUse,
  getCompletionTokenUseIdOrNull,
} from '../../cron/judgmentsJobs/judgmentCompletionTokenUseOutbox.ts'
import {
  getJudgmentJobSqliteService,
  JudgmentPromptClaimIdentityError,
} from '../../cron/judgmentsJobs/judgmentJobSqliteService.ts'
import {getDateValue} from '../../services/appQueryHelpers.ts'
import {HttpError} from '../../utils/httpError.ts'
import {
  assertCompletionClaimIdentity,
  assertCompletionSnapshotIdentity,
  getCompletionIdentity,
  getExistingCompletionAckResponse,
} from './completeJudgmentJobPrompt/completionIdentity.ts'
import {
  getCompletionRetryAfterMs,
  recordCompletionProviderFailure,
  recordCompletionProviderSuccess,
} from './completeJudgmentJobPrompt/completionProviderHealth.ts'
import {
  getCompletionAnsweredOriginal,
  getCompletionAnsweredOriginalAsArray,
  getCompletionRequestAttemptsJson,
  getJudgmentValueRecord,
} from './completeJudgmentJobPrompt/completionValues.ts'
import type {JudgmentCompletionBody} from './completeJudgmentJobPrompt/judgmentCompletionTypes.ts'

export const completeJudgmentJobPrompt = async (jobId: string, body: JudgmentCompletionBody) => {
  if (body.jobId !== jobId) {
    throw new HttpError(409, 'jobId mismatch for judgment completion')
  }

  const existingAckResponse = await getExistingCompletionAckResponse(jobId, body)

  if (existingAckResponse) {
    return existingAckResponse
  }

  const identity = getCompletionIdentity(jobId, body)
  const allowUnclaimedReadyPrompt = !['failed', 'retry', 'skipped'].includes(body.status ?? '')

  const claimIdentitySource = await assertCompletionClaimIdentity(identity, {allowUnclaimedReadyPrompt})

  // A live claim row already stores the snapshot id and hash written from the DuckDB snapshot at
  // claim time. Only a requeued ready row has lost them, so only then check DuckDB.
  if (claimIdentitySource === 'readyPrompt') {
    await assertCompletionSnapshotIdentity(identity)
  }
  const tokenUseId = getCompletionTokenUseIdOrNull(body)
  const completionAckRequestAttemptsJson = getCompletionRequestAttemptsJson(body, 'completion_ack', tokenUseId)

  if (body.status === 'retry') {
    const providerHealth = await recordCompletionProviderFailure(jobId, body)

    await getJudgmentJobSqliteService().markPromptAsRetry(
      jobId,
      body.queueRecordId,
      getCompletionRetryAfterMs(body, providerHealth),
      {
        claimId: body.claimId,
        queuePromptId: body.queueRecordId,
        status: 'retry',
        requestAttemptsJson: completionAckRequestAttemptsJson,
        tokenUseId,
      },
    )
    await enqueueCompletionTokenUse(body)
    return {data: {claimId: body.claimId, queueRecordId: body.queueRecordId, status: 'retry'}, error: null}
  }

  if (body.status === 'skipped') {
    await getJudgmentJobSqliteService().markPromptAsSkipped(
      jobId,
      body.queueRecordId,
      body.skipReason ?? 'no_fulltext',
      {
        claimId: body.claimId,
        queuePromptId: body.queueRecordId,
        status: 'skipped',
        requestAttemptsJson: completionAckRequestAttemptsJson,
        tokenUseId,
      },
    )
    await enqueueCompletionTokenUse(body)
    return {data: {claimId: body.claimId, queueRecordId: body.queueRecordId, status: 'skipped'}, error: null}
  }

  if (body.status === 'failed') {
    await getJudgmentJobSqliteService().markPromptAsClosed(jobId, body.queueRecordId, 'ownerCompletionFailed', {
      claimId: body.claimId,
      queuePromptId: body.queueRecordId,
      status: 'failed',
      requestAttemptsJson: completionAckRequestAttemptsJson,
      tokenUseId,
    })
    await recordCompletionProviderFailure(jobId, body)
    await enqueueCompletionTokenUse(body)
    return {data: {claimId: body.claimId, queueRecordId: body.queueRecordId, status: 'failed'}, error: null}
  }

  const judgment = getJudgmentValueRecord(body)
  const answer = judgment.answer ?? body.answeredOriginal
  const now = new Date()
  const judgmentId = body.judgmentId ?? crypto.randomUUID()

  try {
    await getJudgmentJobSqliteService().recordJudgmentSuccess(
      jobId,
      {
        answeredOriginal: getCompletionAnsweredOriginal(body.answeredOriginal ?? answer),
        answeredOriginalAsArray: getCompletionAnsweredOriginalAsArray(body.answeredOriginalAsArray, answer),
        articleId: body.articleId,
        claimId: body.claimId,
        chunkCount: body.chunkCount ?? null,
        chunkPlanHash: body.chunkPlanHash ?? null,
        chunkingStrategy: body.chunkingStrategy ?? null,
        confidenceOriginal: body.confidenceOriginal ?? 50,
        createdAt: getDateValue(judgment.createdAt) ?? now,
        fullTextMode: body.fullTextMode ?? null,
        explanation: body.explanation ?? (typeof judgment.explanation === 'string' ? judgment.explanation : null),
        executionSnapshotHash: body.executionSnapshotHash,
        executionSnapshotId: body.executionSnapshotId,
        fullTextStrategyId: body.fullTextStrategyId ?? null,
        isAnswered: body.isAnswered ?? true,
        judgmentId,
        modelId: body.modelId,
        projectId: body.projectId,
        promptId: body.promptId,
        queuePromptId: body.queueRecordId,
        completionTokenUseId: tokenUseId,
        quotes: body.quotes ?? judgment.quotes ?? null,
        rawResponseJson: body.rawResponseJson ?? body.judgment ?? null,
        requestAttemptsJson: getCompletionRequestAttemptsJson(body, 'judgment_outbox', judgmentId),
        snapshotProjectId: body.projectId,
        snapshotProjectModelName: null,
        systemPromptVariant: body.systemPromptVariant ?? null,
        updatedAt: getDateValue(judgment.updatedAt) ?? now,
        useAbstract: body.useAbstract,
        useFulltext: body.useFulltext,
        useFulltextNoImages: body.useFulltextNoImages,
        useMetadata: body.useMetadata ?? null,
        useTitle: body.useTitle,
      },
      {allowUnclaimedReadyPrompt},
    )
  } catch (error) {
    if (error instanceof JudgmentPromptClaimIdentityError) {
      throw new HttpError(409, error.message)
    }

    throw error
  }
  await recordCompletionProviderSuccess(jobId)
  await enqueueCompletionTokenUse(body)

  return {data: {claimId: body.claimId, queueRecordId: body.queueRecordId, status: 'judged'}, error: null}
}
