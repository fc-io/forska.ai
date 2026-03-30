import {HttpError} from '../utils/httpError.ts'
import {resolveMatchedProviderRuntimeCredentials} from './providerAuthService.ts'
import {getProviderConnectionForStoredModel} from './providerConnectionRepository.ts'
import {getProviderModels} from './providerModelRepository.ts'
import {requireProviderRegistryEntry} from './providerRegistry.ts'
import {discoverProviderRuntimeModel} from './providerRuntimeDetector.ts'
import {resolveProviderConnectionRuntimeMatch} from './providerRuntimeMatchResolver.ts'
import {type ProviderListedModel, type ProviderModelRecord} from './providerTypes.ts'

type StoredProviderModelRuntimeMatchReason =
  | 'missing-stored-model'
  | 'runtime-mismatch'
  | 'runtime-model-unavailable'
  | 'runtime-unreachable'
  | 'runtime-verification-failed'

type StoredProviderModelRuntimeMatch = {
  message: string | null
  ok: boolean
  reason: StoredProviderModelRuntimeMatchReason | null
}

const runtimeMatchCacheMs = 10_000

const runtimeMatchCache = new Map<string, {result: StoredProviderModelRuntimeMatch; timestamp: number}>()

const getTrimmedValue = (value: string | null | undefined): string | null => {
  const normalized = String(value ?? '').trim()

  return normalized === '' ? null : normalized
}

const getUniqueModelNames = (values: Array<string | null | undefined>): string[] => {
  return Array.from(
    new Set(
      values.flatMap((value) => {
        const normalized = getTrimmedValue(value)

        return normalized ? [normalized] : []
      }),
    ),
  )
}

const getStoredModelNames = (model: ProviderModelRecord): string[] => {
  return getUniqueModelNames([model.remoteModelId, model.modelName])
}

const getListedModelNames = (listedModels: ProviderListedModel[]): string[] => {
  return getUniqueModelNames(
    listedModels.flatMap((listedModel) => {
      return [listedModel.remoteModelId, listedModel.modelName]
    }),
  )
}

const getRuntimeModelNames = ({
  listedModels,
  runtimeMetadata,
}: {
  listedModels: ProviderListedModel[]
  runtimeMetadata: Awaited<ReturnType<typeof discoverProviderRuntimeModel>>
}): string[] => {
  return getUniqueModelNames([
    ...getListedModelNames(listedModels),
    ...(runtimeMetadata?.modelNames ?? []),
    runtimeMetadata?.modelName,
    runtimeMetadata?.servedModelName,
  ])
}

const hasRuntimeModelMatch = ({
  runtimeModelNames,
  storedModelNames,
}: {
  runtimeModelNames: string[]
  storedModelNames: string[]
}): boolean => {
  return storedModelNames.some((storedModelName) => {
    return runtimeModelNames.includes(storedModelName)
  })
}

const getModelNamesLabel = (modelNames: string[]): string => {
  return modelNames.join(', ')
}

const getExpectedModelNamesLabel = (modelNames: string[]): string => {
  return modelNames.length === 1 ? getModelNamesLabel(modelNames) : `one of ${getModelNamesLabel(modelNames)}`
}

const getErrorMessage = (error: unknown): string | null => {
  return getTrimmedValue(error instanceof Error ? error.message : String(error))
}

const getMessageDetailSuffix = (detail: string | null): string => {
  return detail ? ` ${detail}` : ''
}

const hasConnectionErrorMarker = ({
  errorName,
  message,
}: {
  errorName: string | null
  message: string | null
}): boolean => {
  const normalizedMessage = String(message ?? '').toLowerCase()

  return (
    normalizedMessage.includes('connection error')
    || normalizedMessage.includes('connect')
    || normalizedMessage.includes('econnrefused')
    || normalizedMessage.includes('econnreset')
    || normalizedMessage.includes('enotfound')
    || normalizedMessage.includes('etimedout')
    || normalizedMessage.includes('timeout')
    || normalizedMessage.includes('socket')
    || normalizedMessage.includes('network')
    || normalizedMessage.includes('fetch failed')
    || normalizedMessage.includes('bad gateway')
    || normalizedMessage.includes('service unavailable')
    || normalizedMessage.includes('gateway timeout')
    || normalizedMessage.includes('unable to connect')
    || errorName === 'AbortError'
    || errorName === 'APIConnectionError'
    || errorName === 'ConnectionError'
    || errorName === 'TypeError'
  )
}

const isConnectionError = (error: unknown): boolean => {
  return error instanceof Error
    ? hasConnectionErrorMarker({errorName: error.name, message: error.message})
    : hasConnectionErrorMarker({errorName: null, message: String(error)})
}

const getFailedRuntimeMatch = ({
  message,
  reason,
}: {
  message: string
  reason: StoredProviderModelRuntimeMatchReason
}): StoredProviderModelRuntimeMatch => {
  return {message, ok: false, reason}
}

const getSuccessfulRuntimeMatch = (): StoredProviderModelRuntimeMatch => {
  return {message: null, ok: true, reason: null}
}

const getMissingStoredModelNamesMessage = (): string => {
  return 'Project model is missing a remote model id.'
}

const getMissingRuntimeModelNamesMessage = (baseURL: string | null, storedModelNames: string[]): string => {
  const resolvedBaseURL = getTrimmedValue(baseURL)
  const targetLabel = resolvedBaseURL ? ` at ${resolvedBaseURL}` : ''

  return `Connected to the configured SGLang runtime${targetLabel}, but it did not report which model it serves. Expected ${getExpectedModelNamesLabel(storedModelNames)}.`
}

const getRuntimeMismatchMessage = ({
  baseURL,
  runtimeModelNames,
  storedModelNames,
}: {
  baseURL: string | null
  runtimeModelNames: string[]
  storedModelNames: string[]
}): string => {
  const resolvedBaseURL = getTrimmedValue(baseURL)
  const targetLabel = resolvedBaseURL ? ` at ${resolvedBaseURL}` : ''

  return `Configured SGLang runtime${targetLabel} is serving ${getModelNamesLabel(runtimeModelNames)}, but the project expects ${getExpectedModelNamesLabel(storedModelNames)}.`
}

const getRuntimeUnreachableMessage = (baseURL: string | null, storedModelNames: string[], error: unknown): string => {
  const resolvedBaseURL = getTrimmedValue(baseURL)
  const targetLabel = resolvedBaseURL ? ` at ${resolvedBaseURL}` : ''
  const detail = getErrorMessage(error)

  return `Could not reach the configured SGLang runtime${targetLabel}, so Forska could not confirm it serves ${getExpectedModelNamesLabel(storedModelNames)}.${getMessageDetailSuffix(detail)}`
}

const getRuntimeVerificationFailureMessage = (
  baseURL: string | null,
  storedModelNames: string[],
  error: unknown,
): string => {
  const resolvedBaseURL = getTrimmedValue(baseURL)
  const targetLabel = resolvedBaseURL ? ` at ${resolvedBaseURL}` : ''
  const detail = getErrorMessage(error)

  return `Could not confirm the configured SGLang runtime${targetLabel} serves ${getExpectedModelNamesLabel(storedModelNames)}.${getMessageDetailSuffix(detail)}`
}

const getStoredProviderRuntimeContext = async (
  modelId: string,
): Promise<{connectionId: string; model: ProviderModelRecord}> => {
  const models = await getProviderModels([modelId])
  const model = models.get(modelId) ?? null
  const connectionId = model?.providerConnectionId ?? null

  if (!model || !connectionId) {
    throw new Error('Stored provider model not found')
  }

  return {connectionId, model}
}

const getStoredProviderModelRuntimeMatchUncached = async ({
  modelId,
}: {
  modelId: string
}): Promise<StoredProviderModelRuntimeMatch> => {
  const {connectionId, model} = await getStoredProviderRuntimeContext(modelId)
  const connection = await getProviderConnectionForStoredModel(modelId)

  if (!connection || connection.id !== connectionId) {
    throw new Error('Stored provider model not found')
  }

  if (connection.providerKind !== 'sglang') {
    return getSuccessfulRuntimeMatch()
  }

  const storedModelNames = getStoredModelNames(model)

  if (storedModelNames.length === 0) {
    return getFailedRuntimeMatch({message: getMissingStoredModelNamesMessage(), reason: 'missing-stored-model'})
  }

  const runtimeMatch = await resolveProviderConnectionRuntimeMatch({
    baseURL: connection.baseURL,
    config: connection.config,
    providerKind: connection.providerKind,
    savedModelIds: storedModelNames,
  })

  try {
    const definition = requireProviderRegistryEntry(connection.providerKind)
    const runtimeCredentials = await resolveMatchedProviderRuntimeCredentials(connection)
    const runtimeBaseURL = runtimeMatch.effectiveBaseURL ?? runtimeCredentials.baseURL
    const [listedModels, runtimeMetadata] = await Promise.all([
      definition.listModels({connection, runtimeCredentials}),
      discoverProviderRuntimeModel({baseURL: runtimeBaseURL, providerKind: connection.providerKind}),
    ])
    const runtimeModelNames = getRuntimeModelNames({listedModels, runtimeMetadata})

    return runtimeModelNames.length === 0
      ? getFailedRuntimeMatch({
          message: getMissingRuntimeModelNamesMessage(runtimeBaseURL, storedModelNames),
          reason: 'runtime-model-unavailable',
        })
      : hasRuntimeModelMatch({runtimeModelNames, storedModelNames})
        ? getSuccessfulRuntimeMatch()
        : getFailedRuntimeMatch({
            message: getRuntimeMismatchMessage({baseURL: runtimeBaseURL, runtimeModelNames, storedModelNames}),
            reason: 'runtime-mismatch',
          })
  } catch (error) {
    return isConnectionError(error)
      ? getFailedRuntimeMatch({
          message: getRuntimeUnreachableMessage(
            runtimeMatch.effectiveBaseURL ?? connection.baseURL,
            storedModelNames,
            error,
          ),
          reason: 'runtime-unreachable',
        })
      : getFailedRuntimeMatch({
          message: getRuntimeVerificationFailureMessage(
            runtimeMatch.effectiveBaseURL ?? connection.baseURL,
            storedModelNames,
            error,
          ),
          reason: 'runtime-verification-failed',
        })
  }
}

export const getStoredProviderModelRuntimeMatch = async ({
  modelId,
}: {
  modelId: string
}): Promise<StoredProviderModelRuntimeMatch> => {
  const cacheKey = modelId
  const existing = runtimeMatchCache.get(cacheKey)

  if (existing && Date.now() - existing.timestamp < runtimeMatchCacheMs) {
    return existing.result
  }

  const result = await getStoredProviderModelRuntimeMatchUncached({modelId})
  runtimeMatchCache.set(cacheKey, {result, timestamp: Date.now()})
  return result
}

export const assertStoredProviderModelRuntimeMatch = async ({modelId}: {modelId: string}): Promise<void> => {
  const result = await getStoredProviderModelRuntimeMatch({modelId})

  if (!result.ok) {
    throw new HttpError(400, result.message ?? 'Could not confirm the configured SGLang runtime model')
  }
}
