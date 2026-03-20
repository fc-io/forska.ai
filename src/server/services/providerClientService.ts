import {requireProviderRegistryEntry} from '../providers/providerRegistry.ts'
import {
  type ProviderConnectionRecord,
  type ProviderInvocationResult as RegistryProviderInvocationResult,
  type ProviderListedModel as RegistryProviderListedModel,
  type ProviderModelRecord,
} from '../providers/providerTypes.ts'
import {
  getProviderCatalogEntry,
  getProviderDefaultBaseURL,
  normalizeProviderKind,
  type ProviderKind,
} from './providerCatalog.ts'

export type ProviderConnectionTestResult = {message: string; modelCount: number | null}

export type ProviderInvocationResult = {
  text: string
  usage: {completionTokens: number; promptTokens: number; totalTokens: number}
}

export type ProviderListModelsInput = {
  baseURL: string | null
  providerKind: string | null | undefined
  secretRef: string | null
}

export type ProviderInvokeInput = {
  baseURL: string
  maxCompletionTokens: number
  modelName: string
  outputSchema: unknown
  prompt: string
  providerKind: string | null | undefined
  secretRef: string | null
  systemPrompt: string
  temperature: number
  version: string | null
}

export type ProviderListedModel = {
  displayName: string
  metadataJson: unknown
  modelName: string
  remoteModelId: string
  variant: string | null
  version: string | null
}

const getResolvedBaseURL = ({
  baseURL,
  providerKind,
}: {
  baseURL: string | null
  providerKind: ProviderKind
}): string | null => {
  return baseURL ?? getProviderDefaultBaseURL(providerKind)
}

const getCompatibilityAuthMode = ({
  baseURL,
  providerKind,
  secretRef,
}: {
  baseURL: string | null
  providerKind: ProviderKind
  secretRef: string | null
}): string | null => {
  return providerKind === 'codex' ? 'codex-cli' : secretRef ? 'api-key' : baseURL ? 'none' : null
}

const getCompatibilityConnection = ({
  baseURL,
  providerKind,
  secretRef,
}: {
  baseURL: string | null
  providerKind: ProviderKind
  secretRef: string | null
}): ProviderConnectionRecord => {
  const catalog = getProviderCatalogEntry(providerKind)
  const resolvedBaseURL = getResolvedBaseURL({baseURL, providerKind})

  return {
    authMode: getCompatibilityAuthMode({baseURL: resolvedBaseURL, providerKind, secretRef}),
    baseURL: resolvedBaseURL,
    config: {workerUrls: []},
    createdAt: null,
    enabled: true,
    hasSecret: Boolean(secretRef),
    id: `compat:${providerKind}`,
    label: catalog?.label ?? providerKind,
    lastCheckedAt: null,
    lastError: null,
    providerKind,
    secretRef,
    updatedAt: null,
  }
}

const getCompatibilityModel = ({
  baseURL,
  modelName,
  providerKind,
  version,
}: {
  baseURL: string
  modelName: string
  providerKind: ProviderKind
  version: string | null
}): ProviderModelRecord => {
  return {
    baseURL,
    createdAt: null,
    displayName: modelName,
    enabled: true,
    id: `compat:${providerKind}:${modelName}:${version ?? 'default'}`,
    metadataJson: null,
    modelName,
    name: modelName,
    provider: providerKind,
    providerConnectionId: `compat:${providerKind}`,
    remoteModelId: modelName,
    source: 'manual',
    updatedAt: null,
    variant: version,
    version,
  }
}

const getCompatibilityListedModel = (model: RegistryProviderListedModel): ProviderListedModel => {
  return {
    displayName: model.displayName,
    metadataJson: model.metadataJson,
    modelName: model.modelName,
    remoteModelId: model.remoteModelId,
    variant: model.variant,
    version: model.version,
  }
}

const getCompatibilityInvocationResult = (result: RegistryProviderInvocationResult): ProviderInvocationResult => {
  return {
    text: result.text,
    usage: {
      completionTokens: result.usage.completionTokens,
      promptTokens: result.usage.promptTokens,
      totalTokens: result.usage.totalTokens,
    },
  }
}

export const listProviderModels = async ({
  baseURL,
  providerKind,
  secretRef,
}: ProviderListModelsInput): Promise<ProviderListedModel[]> => {
  const normalizedProviderKind = normalizeProviderKind(providerKind)
  const definition = requireProviderRegistryEntry(normalizedProviderKind)
  const connection = getCompatibilityConnection({baseURL, providerKind: normalizedProviderKind, secretRef})
  const runtimeCredentials = await definition.resolveRuntimeCredentials({catalog: definition.catalog, connection})
  const models = await definition.listModels({connection, runtimeCredentials})

  return models.map(getCompatibilityListedModel)
}

export const testProviderConnection = async ({
  baseURL,
  providerKind,
  secretRef,
}: ProviderListModelsInput): Promise<ProviderConnectionTestResult> => {
  const normalizedProviderKind = normalizeProviderKind(providerKind)
  const definition = requireProviderRegistryEntry(normalizedProviderKind)
  const connection = getCompatibilityConnection({baseURL, providerKind: normalizedProviderKind, secretRef})
  const runtimeCredentials = await definition.resolveRuntimeCredentials({catalog: definition.catalog, connection})
  const result = await definition.testConnection({connection, runtimeCredentials})

  if (!result.ok) {
    throw new Error(result.message)
  }

  return {message: result.message, modelCount: result.modelCount}
}

export const invokeProviderModel = async (input: ProviderInvokeInput): Promise<ProviderInvocationResult> => {
  const normalizedProviderKind = normalizeProviderKind(input.providerKind)
  const definition = requireProviderRegistryEntry(normalizedProviderKind)
  const connection = getCompatibilityConnection({
    baseURL: input.baseURL,
    providerKind: normalizedProviderKind,
    secretRef: input.secretRef,
  })
  const runtimeCredentials = await definition.resolveRuntimeCredentials({catalog: definition.catalog, connection})
  const model = getCompatibilityModel({
    baseURL: input.baseURL,
    modelName: input.modelName,
    providerKind: normalizedProviderKind,
    version: input.version,
  })
  const result = await definition.invoke({
    connection,
    model,
    request: {
      maxCompletionTokens: input.maxCompletionTokens,
      outputSchema: input.outputSchema,
      prompt: input.prompt,
      systemPrompt: input.systemPrompt,
      temperature: input.temperature,
    },
    runtimeCredentials: {...runtimeCredentials, baseURL: input.baseURL},
  })

  return getCompatibilityInvocationResult(result)
}

export const getProviderClientService = () => {
  return {invokeProviderModel, listProviderModels, testProviderConnection}
}
