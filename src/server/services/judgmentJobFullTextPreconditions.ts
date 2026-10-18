import {
  type FullTextJudgingStrategy,
  getFullTextImageTokenEstimateError,
  getModelContextChunkPolicyError,
} from '../../agent/judge/fullTextJudgingInput.ts'
import {MAX_COMPLETION_TOKENS} from '../../agent/judge/judgeCompletionTokens.ts'
import {getJudgmentJobSqliteService} from '../cron/judgmentsJobs/judgmentJobSqliteService.ts'
import {getLegacyFullTextStrategyMessage} from '../cron/judgmentsJobs/judgmentsJobsSendToLLM/prepareFullTextJudging.ts'
import {getFullTextJudgingStrategy} from '../fullText/fullTextJudgingBlocks.ts'
import {FULL_TEXT_STRATEGY_LEGACY, isReservedFullTextStrategyId} from '../fullText/fullTextStrategy.ts'
import {
  getModelContext,
  getModelContextWindowMissingError,
  type ProviderModelCapabilityModel,
} from '../providers/providerModelCapabilities.ts'
import {getAppDatabaseService} from './appDatabaseService.ts'
import {normalizeProviderKind} from './providerCatalog.ts'

export type FullTextPreconditionModel = {
  model: ProviderModelCapabilityModel
  modelName: string
  providerConnectionId: string | null
}

type FullTextClaimGateEntry = {checkedAt: number; message: string | null}

export const judgmentJobFullTextClaimGateTtlMs = 30_000

const fullTextClaimGateEntries = new Map<string, FullTextClaimGateEntry>()

const getChunkPolicyModelError = (
  model: FullTextPreconditionModel,
  strategy: FullTextJudgingStrategy,
): string | null => {
  return getModelContextWindowMissingError(model)
    ? null
    : getModelContextChunkPolicyError({
        modelContext: getModelContext({...model, reservedCompletionTokens: MAX_COMPLETION_TOKENS}),
        modelName: model.modelName,
        strategy,
      })
}

const getNativeImagesModelPreconditionError = async (
  model: FullTextPreconditionModel,
  strategy: FullTextJudgingStrategy,
): Promise<string | null> => {
  return strategy.figureMode === 'native_images'
    ? (await import('../fullText/nativeImagesModelCheck.ts')).getNativeImagesModelError({
        figureMode: strategy.figureMode,
        model: {...model.model, label: model.modelName},
      })
    : null
}

export const getFullTextJudgingPreconditionError = async ({
  fullTextStrategyId,
  model,
}: {
  fullTextStrategyId: string
  model: FullTextPreconditionModel
}): Promise<string | null> => {
  if (fullTextStrategyId === FULL_TEXT_STRATEGY_LEGACY) {
    return getLegacyFullTextStrategyMessage()
  }

  if (isReservedFullTextStrategyId(fullTextStrategyId)) {
    return null
  }

  const strategy = await getFullTextJudgingStrategy(getAppDatabaseService(), fullTextStrategyId)

  if (!strategy) {
    return `Full-text strategy ${fullTextStrategyId} has no stored chunk policy and figure mode. Set them on the project's edit page and start the job again.`
  }

  return (
    getFullTextImageTokenEstimateError(strategy)
    ?? getChunkPolicyModelError(model, strategy)
    ?? (await getNativeImagesModelPreconditionError(model, strategy))
  )
}

const getFullTextClaimErrorFromJobInfo = async (jobId: string): Promise<string | null> => {
  const jobInfo = await getJudgmentJobSqliteService().getJobInfo(jobId)

  return jobInfo && !isReservedFullTextStrategyId(jobInfo.fullTextStrategyId)
    ? getFullTextJudgingPreconditionError({
        fullTextStrategyId: jobInfo.fullTextStrategyId,
        model: {
          model: {
            metadataJson: jobInfo.modelMetadataJson,
            providerKind: normalizeProviderKind(jobInfo.modelProvider),
            remoteModelId: jobInfo.modelName,
          },
          modelName: jobInfo.modelName,
          providerConnectionId: null,
        },
      })
    : jobInfo?.fullTextStrategyId === FULL_TEXT_STRATEGY_LEGACY
      ? getLegacyFullTextStrategyMessage()
      : null
}

export const getJudgmentJobFullTextClaimError = async (
  jobId: string,
  now: number = Date.now(),
): Promise<string | null> => {
  const cached = fullTextClaimGateEntries.get(jobId)

  if (cached && now - cached.checkedAt < judgmentJobFullTextClaimGateTtlMs) {
    return cached.message
  }

  const message = await getFullTextClaimErrorFromJobInfo(jobId)

  fullTextClaimGateEntries.set(jobId, {checkedAt: now, message})

  return message
}

export const resetJudgmentJobFullTextClaimGateForTests = (): void => {
  fullTextClaimGateEntries.clear()
}
