import {type ProviderKind} from '../services/providerCatalog.ts'
import {type ProviderListedModel} from './providerTypes.ts'

type ProviderModelContextWindow = {inputTokens: number | null; outputTokens: number | null; totalTokens: number | null}

type ProviderModelRuntimeMetadata = {
  baseURL: string | null
  modelName: string | null
  raw: unknown
  servedModelName: string | null
}

type ProviderModelMetadataSource = 'manual' | 'provider' | 'provider+runtime' | 'runtime'

type ProviderModelMetadata = {
  discovery: {
    capabilities: {reasoningEfforts: string[]}
    contextWindow: ProviderModelContextWindow
    identity: {
      displayName: string
      modelName: string
      remoteModelId: string
      variant: string | null
      version: string | null
    }
    providerKind: ProviderKind
    runtime: {baseURL: string | null; modelName: string | null; servedModelName: string | null} | null
    source: ProviderModelMetadataSource
  }
  raw: unknown
}

const contextWindowKeys = [
  'contextLength',
  'context_length',
  'contextWindow',
  'context_window',
  'maxInputTokens',
  'max_input_tokens',
  'inputTokenLimit',
  'input_token_limit',
  'maxSequenceLength',
  'max_sequence_length',
  'tokenLimit',
  'token_limit',
  'maxModelLen',
  'max_model_len',
  'maxSeqLen',
  'max_seq_len',
] as const

const outputWindowKeys = [
  'maxOutputTokens',
  'max_output_tokens',
  'outputTokenLimit',
  'output_token_limit',
  'maxCompletionTokens',
  'max_completion_tokens',
] as const

const modelNameKeys = ['model', 'modelName', 'model_name', 'modelPath', 'model_path'] as const
const servedModelNameKeys = ['servedModelName', 'served_model_name'] as const
const reasoningEffortKeys = ['reasoningEffort', 'reasoning_effort'] as const
const reasoningEffortsKeys = ['supportedReasoningEfforts', 'supported_reasoning_efforts'] as const

const getPositiveInteger = (value: unknown): number | null => {
  const numericValue = typeof value === 'number' ? value : Number(value)

  return Number.isFinite(numericValue) && numericValue > 0 ? Math.trunc(numericValue) : null
}

const getTrimmedValue = (value: unknown): string | null => {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

const getJsonRecord = (value: unknown): Record<string, unknown> | null => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

const getContextWindowFromKeys = (record: Record<string, unknown>, keys: readonly string[]): number | null => {
  return keys.reduce<number | null>((resolved, key) => {
    return resolved ?? getPositiveInteger(record[key])
  }, null)
}

const getContextWindowFromMetadata = (value: unknown): ProviderModelContextWindow => {
  const record = getJsonRecord(value)
  const arrayValue = Array.isArray(value) ? value : null

  return arrayValue
    ? arrayValue.reduce<ProviderModelContextWindow>(
        (resolved, entry) => {
          const nested = getContextWindowFromMetadata(entry)

          return {
            inputTokens: resolved.inputTokens ?? nested.inputTokens,
            outputTokens: resolved.outputTokens ?? nested.outputTokens,
            totalTokens: resolved.totalTokens ?? nested.totalTokens,
          }
        },
        {inputTokens: null, outputTokens: null, totalTokens: null},
      )
    : record
      ? Object.values(record).reduce<ProviderModelContextWindow>(
          (resolved, entry) => {
            const nested = getContextWindowFromMetadata(entry)

            return {
              inputTokens:
                resolved.inputTokens ?? getContextWindowFromKeys(record, contextWindowKeys) ?? nested.inputTokens,
              outputTokens:
                resolved.outputTokens ?? getContextWindowFromKeys(record, outputWindowKeys) ?? nested.outputTokens,
              totalTokens:
                resolved.totalTokens ?? getContextWindowFromKeys(record, contextWindowKeys) ?? nested.totalTokens,
            }
          },
          {inputTokens: null, outputTokens: null, totalTokens: null},
        )
      : {inputTokens: getPositiveInteger(value), outputTokens: null, totalTokens: getPositiveInteger(value)}
}

const getReasoningEffortsFromEntry = (value: unknown): string[] => {
  const record = getJsonRecord(value)
  const reasoningEffort = record
    ? reasoningEffortKeys.reduce<string | null>((resolved, key) => {
        return resolved ?? getTrimmedValue(record[key])
      }, null)
    : null

  return reasoningEffort ? [reasoningEffort] : []
}

const getReasoningEffortsFromMetadata = (value: unknown): string[] => {
  const arrayValue = Array.isArray(value) ? value : null
  const record = getJsonRecord(value)

  return arrayValue
    ? Array.from(
        new Set(
          arrayValue.flatMap((entry) => {
            return getReasoningEffortsFromMetadata(entry)
          }),
        ),
      )
    : record
      ? Array.from(
          new Set([
            ...reasoningEffortsKeys.flatMap((key) => {
              const entry = record[key]

              return Array.isArray(entry)
                ? entry.flatMap((item) => {
                    return getReasoningEffortsFromEntry(item)
                  })
                : []
            }),
            ...Object.values(record).flatMap((entry) => {
              return getReasoningEffortsFromMetadata(entry)
            }),
          ]),
        )
      : []
}

const getIdentityValue = (value: unknown, keys: readonly string[]): string | null => {
  const record = getJsonRecord(value)
  const arrayValue = Array.isArray(value) ? value : null

  return arrayValue
    ? arrayValue.reduce<string | null>((resolved, entry) => {
        return resolved ?? getIdentityValue(entry, keys)
      }, null)
    : record
      ? keys.reduce<string | null>((resolved, key) => {
          return resolved ?? getTrimmedValue(record[key]) ?? getIdentityValue(record[key], keys)
        }, null)
      : null
}

const getMetadataSource = ({
  runtimeMetadata,
  source,
}: {
  runtimeMetadata: ProviderModelRuntimeMetadata | null
  source: ProviderModelMetadataSource
}): ProviderModelMetadataSource => {
  return source === 'provider' && runtimeMetadata ? 'provider+runtime' : source
}

const getContextWindow = ({
  rawMetadata,
  runtimeMetadata,
}: {
  rawMetadata: unknown
  runtimeMetadata: ProviderModelRuntimeMetadata | null
}): ProviderModelContextWindow => {
  const rawContextWindow = getContextWindowFromMetadata(rawMetadata)
  const runtimeContextWindow = getContextWindowFromMetadata(runtimeMetadata?.raw ?? null)

  return {
    inputTokens: rawContextWindow.inputTokens ?? runtimeContextWindow.inputTokens,
    outputTokens: rawContextWindow.outputTokens ?? runtimeContextWindow.outputTokens,
    totalTokens: rawContextWindow.totalTokens ?? runtimeContextWindow.totalTokens,
  }
}

export const getProviderRuntimeModelIdentity = (
  value: unknown,
): {modelName: string | null; servedModelName: string | null} => {
  return {
    modelName: getIdentityValue(value, modelNameKeys),
    servedModelName: getIdentityValue(value, servedModelNameKeys),
  }
}

export const getProviderModelMetadataContextLength = (value: unknown): number | null => {
  const metadataRecord = getJsonRecord(value)
  const discovery = getJsonRecord(metadataRecord?.discovery)
  const contextWindow = getJsonRecord(discovery?.contextWindow)
  const discoveryContextLength =
    getPositiveInteger(contextWindow?.totalTokens) ?? getPositiveInteger(contextWindow?.inputTokens)

  return discoveryContextLength ?? getContextWindowFromMetadata(metadataRecord?.raw ?? value).totalTokens
}

export const getProviderModelMetadataReasoningEfforts = (value: unknown): string[] => {
  const metadataRecord = getJsonRecord(value)
  const discovery = getJsonRecord(metadataRecord?.discovery)
  const capabilities = getJsonRecord(discovery?.capabilities)
  const reasoningEfforts = Array.isArray(capabilities?.reasoningEfforts)
    ? capabilities.reasoningEfforts.filter((entry): entry is string => {
        return typeof entry === 'string' && entry.trim().length > 0
      })
    : []

  return reasoningEfforts.length > 0 ? reasoningEfforts : getReasoningEffortsFromMetadata(metadataRecord?.raw ?? value)
}

export const getProviderModelMetadataSource = (value: unknown): string | null => {
  const metadataRecord = getJsonRecord(value)
  const discovery = getJsonRecord(metadataRecord?.discovery)

  return getTrimmedValue(discovery?.source)
}

export const getNormalizedProviderModelMetadata = ({
  listedModel,
  providerKind,
  rawMetadata,
  runtimeMetadata,
  source,
}: {
  listedModel: ProviderListedModel
  providerKind: ProviderKind
  rawMetadata: unknown
  runtimeMetadata?: ProviderModelRuntimeMetadata | null
  source: ProviderModelMetadataSource
}): ProviderModelMetadata => {
  return {
    discovery: {
      capabilities: {
        reasoningEfforts: Array.from(
          new Set([
            ...getProviderModelMetadataReasoningEfforts(rawMetadata),
            ...getProviderModelMetadataReasoningEfforts(runtimeMetadata?.raw ?? null),
          ]),
        ),
      },
      contextWindow: getContextWindow({rawMetadata, runtimeMetadata: runtimeMetadata ?? null}),
      identity: {
        displayName: listedModel.displayName,
        modelName: listedModel.modelName,
        remoteModelId: listedModel.remoteModelId,
        variant: listedModel.variant,
        version: listedModel.version,
      },
      providerKind,
      runtime: runtimeMetadata
        ? {
            baseURL: runtimeMetadata.baseURL,
            modelName: runtimeMetadata.modelName,
            servedModelName: runtimeMetadata.servedModelName,
          }
        : null,
      source: getMetadataSource({runtimeMetadata: runtimeMetadata ?? null, source}),
    },
    raw: rawMetadata,
  }
}

export const getManualProviderModelMetadata = ({
  displayName,
  modelName,
  providerKind,
  remoteModelId,
  variant,
  version,
}: {
  displayName: string
  modelName: string
  providerKind: ProviderKind
  remoteModelId: string
  variant: string | null
  version: string | null
}) => {
  return getNormalizedProviderModelMetadata({
    listedModel: {displayName, metadataJson: null, modelName, remoteModelId, variant, version},
    providerKind,
    rawMetadata: null,
    source: 'manual',
  })
}
