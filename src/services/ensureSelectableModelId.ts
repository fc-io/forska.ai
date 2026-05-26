import {getProviderModelThinkingOption} from '../utils/providerModelOptions.ts'
import {apiClient} from './apiClient'
import {handleApiResponse} from './utils/handleApiResponse'

type EnsureModelResponse = {data: {modelId: string}; error: null}
type MaterializeProviderModelResponse = {data: {modelId: string}; error: null}

type EnsureSelectableModel = {
  id: string
  modelName: string | null
  name: string
  provider: string | null
  providerConnectionId?: string | null
  version: string | null
}

const getNormalizedProvider = (value: string | null | undefined) => {
  return String(value ?? '')
    .trim()
    .toLowerCase()
}

const shouldEnsureSelectableModel = ({provider, version}: Pick<EnsureSelectableModel, 'provider' | 'version'>) => {
  const normalizedProvider = getNormalizedProvider(provider)
  const normalizedVersion = String(version ?? '').trim()

  return normalizedProvider === 'codex' || (normalizedProvider === 'anthropic' && normalizedVersion.length > 0)
}

const getProviderDisplayName = (provider: string) => {
  return provider === 'codex' ? 'Codex' : provider === 'anthropic' ? 'Anthropic' : 'provider'
}

const getSelectedModelName = (selectedModel: EnsureSelectableModel, provider: string) => {
  const modelName = selectedModel.modelName?.trim() ?? ''

  if (!modelName) {
    throw new Error(`Selected ${getProviderDisplayName(provider)} model is missing modelName`)
  }

  return modelName
}

const ensureCodexSelectableModelId = async (selectedModel: EnsureSelectableModel, modelName: string) => {
  const response = await apiClient.api.models.ensure.post({
    modelName,
    name: selectedModel.name,
    provider: 'codex',
    version: selectedModel.version ?? undefined,
  })
  const result = handleApiResponse<EnsureModelResponse>(
    response as unknown as {data?: EnsureModelResponse; error?: unknown; status?: number},
    'Failed to ensure Codex model',
  )

  return result.data.modelId
}

const ensureAnthropicSelectableModelId = async (selectedModel: EnsureSelectableModel, modelName: string) => {
  const providerConnectionId = selectedModel.providerConnectionId?.trim() ?? ''
  const version = selectedModel.version?.trim() ?? ''

  if (!providerConnectionId) {
    throw new Error('Selected Anthropic model is missing providerConnectionId')
  }

  if (!version) {
    throw new Error('Selected Anthropic model is missing thinking level')
  }

  const thinking = getProviderModelThinkingOption(version)

  if (!thinking) {
    throw new Error('Selected Anthropic model has an unsupported thinking level')
  }

  const response = await apiClient.api['provider-connections']({id: providerConnectionId}).models.post({
    displayName: selectedModel.name,
    options: {thinking},
    remoteModelId: modelName,
    variant: version,
  })
  const result = handleApiResponse<MaterializeProviderModelResponse>(
    response as unknown as {data?: MaterializeProviderModelResponse; error?: unknown; status?: number},
    'Failed to ensure Anthropic model',
  )

  return result.data.modelId
}

export const ensureSelectableModelId = async (selectedModel: EnsureSelectableModel): Promise<string> => {
  const provider = getNormalizedProvider(selectedModel.provider)

  if (!shouldEnsureSelectableModel(selectedModel)) {
    return selectedModel.id
  }

  const modelName = getSelectedModelName(selectedModel, provider)

  return provider === 'codex'
    ? ensureCodexSelectableModelId(selectedModel, modelName)
    : ensureAnthropicSelectableModelId(selectedModel, modelName)
}
