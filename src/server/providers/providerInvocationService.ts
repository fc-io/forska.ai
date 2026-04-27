import {resolveProviderRuntimeCredentials} from './providerAuthService.ts'
import {getProviderConnectionForStoredModel} from './providerConnectionRepository.ts'
import {getProviderModels} from './providerModelRepository.ts'
import {requireProviderRegistryEntry} from './providerRegistry.ts'
import {
  type ProviderConnectionRecord,
  type ProviderInvocationResult,
  type ProviderInvokeRequest,
  type ProviderModelRecord,
} from './providerTypes.ts'

export type StoredProviderInvocationContext = {connection: ProviderConnectionRecord; model: ProviderModelRecord}
export type StoredProviderInvocationInput = ProviderInvokeRequest & {
  baseURLOverride?: string | null
  invocationContext?: StoredProviderInvocationContext
  modelId: string
}

const getStoredProviderInvocationContext = async (modelId: string): Promise<StoredProviderInvocationContext> => {
  const [connection, models] = await Promise.all([
    getProviderConnectionForStoredModel(modelId),
    getProviderModels([modelId]),
  ])
  const model = models.get(modelId) ?? null

  if (!connection || !model) {
    throw new Error('Stored provider model not found')
  }

  return {connection, model}
}

export const invokeStoredProviderModel = async ({
  baseURLOverride,
  invocationContext,
  maxCompletionTokens,
  modelId,
  outputSchema,
  prompt,
  systemPrompt,
  temperature,
}: StoredProviderInvocationInput): Promise<ProviderInvocationResult> => {
  const {connection, model} = invocationContext ?? (await getStoredProviderInvocationContext(modelId))
  const definition = requireProviderRegistryEntry(connection.providerKind)
  const runtimeCredentials = invocationContext
    ? await definition.resolveRuntimeCredentials({catalog: definition.catalog, connection})
    : await resolveProviderRuntimeCredentials(connection)
  const nextRuntimeCredentials = baseURLOverride
    ? {...runtimeCredentials, baseURL: baseURLOverride}
    : runtimeCredentials

  return definition.invoke({
    connection,
    model,
    request: {maxCompletionTokens, outputSchema, prompt, systemPrompt, temperature},
    runtimeCredentials: nextRuntimeCredentials,
  })
}

export const getProviderInvocationService = () => {
  return {invokeStoredModel: invokeStoredProviderModel}
}
