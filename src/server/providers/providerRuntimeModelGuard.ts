import {HttpError} from '../utils/httpError.ts'
import {resolveProviderRuntimeCredentials} from './providerAuthService.ts'
import {getProviderConnectionForStoredModel} from './providerConnectionRepository.ts'
import {getProviderModels} from './providerModelRepository.ts'
import {requireProviderRegistryEntry} from './providerRegistry.ts'
import {discoverOpenAICompatibleRuntimeModel} from './providerRuntimeDiscovery.ts'
import {type ProviderListedModel, type ProviderModelRecord} from './providerTypes.ts'

type StoredProviderModelRuntimeMatch = {message: string | null; ok: boolean}

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
  runtimeMetadata: Awaited<ReturnType<typeof discoverOpenAICompatibleRuntimeModel>>
}): string[] => {
  return getUniqueModelNames([
    ...getListedModelNames(listedModels),
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

const getMissingStoredModelNamesMessage = (): string => {
  return 'Selected project model is missing a remote model id'
}

const getMissingRuntimeModelNamesMessage = (baseURL: string | null, storedModelNames: string[]): string => {
  const resolvedBaseURL = getTrimmedValue(baseURL)
  const targetLabel = resolvedBaseURL ? ` at ${resolvedBaseURL}` : ''

  return `Could not verify the active SGLang model${targetLabel}. Expected ${getModelNamesLabel(storedModelNames)}.`
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

  return `Project model ${getModelNamesLabel(storedModelNames)} does not match the active SGLang runtime${targetLabel}. Runtime reports ${getModelNamesLabel(runtimeModelNames)}.`
}

const getRuntimeVerificationFailureMessage = (baseURL: string | null, error: unknown): string => {
  const resolvedBaseURL = getTrimmedValue(baseURL)
  const targetLabel = resolvedBaseURL ? ` at ${resolvedBaseURL}` : ''
  const message = error instanceof Error ? error.message : String(error)

  return `Failed to verify the active SGLang model${targetLabel}: ${message}`
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
    return {message: null, ok: true}
  }

  const storedModelNames = getStoredModelNames(model)

  if (storedModelNames.length === 0) {
    return {message: getMissingStoredModelNamesMessage(), ok: false}
  }

  try {
    const definition = requireProviderRegistryEntry(connection.providerKind)
    const runtimeCredentials = await resolveProviderRuntimeCredentials(connection)
    const [listedModels, runtimeMetadata] = await Promise.all([
      definition.listModels({connection, runtimeCredentials}),
      discoverOpenAICompatibleRuntimeModel({
        baseURL: runtimeCredentials.baseURL,
        providerKind: connection.providerKind,
      }),
    ])
    const runtimeModelNames = getRuntimeModelNames({listedModels, runtimeMetadata})

    return runtimeModelNames.length === 0
      ? {message: getMissingRuntimeModelNamesMessage(runtimeCredentials.baseURL, storedModelNames), ok: false}
      : hasRuntimeModelMatch({runtimeModelNames, storedModelNames})
        ? {message: null, ok: true}
        : {
            message: getRuntimeMismatchMessage({
              baseURL: runtimeCredentials.baseURL,
              runtimeModelNames,
              storedModelNames,
            }),
            ok: false,
          }
  } catch (error) {
    return {message: getRuntimeVerificationFailureMessage(connection.baseURL, error), ok: false}
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
    throw new HttpError(400, result.message ?? 'Failed to verify the active SGLang model')
  }
}
