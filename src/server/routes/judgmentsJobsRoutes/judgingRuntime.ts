import {HttpError} from '../../utils/httpError.ts'
import {shouldCurrentServerRunJudgingLoops} from '../../utils/serverRuntimeRole.ts'
import {getJudgmentImportConsumerAvailability} from './getJudgmentImportConsumerAvailability.ts'

const getJudgingRuntimeReason = async (): Promise<string | null> => {
  if (shouldCurrentServerRunJudgingLoops()) {
    return null
  }

  const importConsumer = await getJudgmentImportConsumerAvailability()

  return importConsumer.eligibleConsumerPresent
    ? null
    : `No eligible ${importConsumer.requiredConsumerRole} is currently registered, so queued prompts cannot be processed.`
}

export const getJudgingRuntime = async (): Promise<{enabled: boolean; reason: string | null}> => {
  const reason = await getJudgingRuntimeReason()
  return {enabled: reason === null, reason}
}

export const assertJudgingRuntimeCanRun = async (): Promise<void> => {
  const reason = await getJudgingRuntimeReason()

  if (reason) {
    throw new HttpError(400, reason)
  }
}
