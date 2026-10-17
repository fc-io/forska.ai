import {type FullTextJudgingStrategy, getModelContextChunkPolicyError} from '../../agent/judge/fullTextJudgingInput.ts'
import {MAX_COMPLETION_TOKENS} from '../../agent/judge/judgeCompletionTokens.ts'
import {getJudgmentJobSqliteService} from '../cron/judgmentsJobs/judgmentJobSqliteService.ts'
import {getLegacyFullTextStrategyMessage} from '../cron/judgmentsJobs/judgmentsJobsSendToLLM/prepareFullTextJudging.ts'
import {getFullTextJudgingStrategy} from '../fullText/fullTextJudgingBlocks.ts'
import {getFullTextJudgingFigureDescriptionConfigError} from '../fullText/fullTextJudgingFigureDescriptions.ts'
import {FULL_TEXT_STRATEGY_LEGACY, isReservedFullTextStrategyId} from '../fullText/fullTextStrategy.ts'
import {
  getModelContext,
  getModelContextWindowMissingError,
  type ProviderModelCapabilityModel,
} from '../providers/providerModelCapabilities.ts'
import {HttpError} from '../utils/httpError.ts'
import {getAppDatabaseService} from './appDatabaseService.ts'
import {getJsonValue, getSqlLiteral} from './appQueryHelpers.ts'
import {normalizeProviderKind} from './providerCatalog.ts'

type FullTextPreconditionModel = {
  model: ProviderModelCapabilityModel
  modelName: string
  providerConnectionId: string | null
}

type FullTextPreconditionModelRow = {
  displayName: string | null
  metadataJson: unknown
  providerConnectionId: string | null
  providerKind: string | null
  remoteModelId: string | null
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

  return getChunkPolicyModelError(model, strategy) ?? (await getFullTextJudgingFigureDescriptionConfigError(strategy))
}

const getModelFromRow = (row: FullTextPreconditionModelRow): FullTextPreconditionModel => {
  return {
    model: {
      metadataJson: getJsonValue(row.metadataJson),
      providerKind: row.providerKind,
      remoteModelId: row.remoteModelId,
    },
    modelName: row.displayName ?? row.remoteModelId ?? 'unknown model',
    providerConnectionId: row.providerConnectionId,
  }
}

const getPreconditionModel = async (modelId: string): Promise<FullTextPreconditionModel | null> => {
  const [row] = await getAppDatabaseService().queryJson<FullTextPreconditionModelRow>(`
    SELECT
      COALESCE(m.display_name, m.name) AS displayName,
      TO_JSON(m.metadata_json) AS metadataJson,
      m.provider_connection_id AS providerConnectionId,
      pc.provider_kind AS providerKind,
      m.remote_model_id AS remoteModelId
    FROM app.model m
    LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
    WHERE m.id = ${getSqlLiteral(modelId)}
    LIMIT 1
  `)

  return row ? getModelFromRow(row) : null
}

export const assertFullTextJudgingPreconditions = async ({
  fullTextStrategyId,
  modelId,
}: {
  fullTextStrategyId: string
  modelId: string
}): Promise<void> => {
  const model =
    isReservedFullTextStrategyId(fullTextStrategyId) && fullTextStrategyId !== FULL_TEXT_STRATEGY_LEGACY
      ? null
      : await getPreconditionModel(modelId)
  const message = model ? await getFullTextJudgingPreconditionError({fullTextStrategyId, model}) : null

  if (message) {
    throw new HttpError(409, message)
  }
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
