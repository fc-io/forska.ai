import type {ProviderContentRefusal} from '../../../agent/judge/providerContentRefusalError.ts'
import type {JudgmentsJobsPromptsSkipReason} from '../../../db/schemaTypes.ts'
import {getJudgmentJobSqliteService, type PromptCompletionAck} from './judgmentJobSqliteService.ts'

export class MissingProviderRefusalError extends Error {
  constructor(queueRecordId: string) {
    super(`Skipped completion for queue prompt ${queueRecordId} has skipReason provider_refusal but no refusal record`)
    this.name = 'MissingProviderRefusalError'
  }
}

const markPromptRefusedFromCompletion = async ({
  completionAck,
  jobId,
  queueRecordId,
  refusal,
}: {
  completionAck: PromptCompletionAck
  jobId: string
  queueRecordId: string
  refusal: ProviderContentRefusal | null | undefined
}): Promise<void> => {
  if (!refusal) {
    throw new MissingProviderRefusalError(queueRecordId)
  }

  await getJudgmentJobSqliteService().markPromptAsRefused(jobId, queueRecordId, refusal, completionAck)
}

export const markPromptSkipFromCompletion = async ({
  completionAck,
  jobId,
  queueRecordId,
  refusal,
  skipReason,
}: {
  completionAck: PromptCompletionAck
  jobId: string
  queueRecordId: string
  refusal: ProviderContentRefusal | null | undefined
  skipReason: JudgmentsJobsPromptsSkipReason
}): Promise<void> => {
  return skipReason === 'provider_refusal'
    ? markPromptRefusedFromCompletion({completionAck, jobId, queueRecordId, refusal})
    : getJudgmentJobSqliteService().markPromptAsSkipped(jobId, queueRecordId, skipReason, completionAck)
}
