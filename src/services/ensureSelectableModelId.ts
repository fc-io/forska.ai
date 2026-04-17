import {apiClient} from './apiClient'
import {handleApiResponse} from './utils/handleApiResponse'

type EnsureModelResponse = {data: {modelId: string}; error: null}

type EnsureSelectableModel = {
  id: string
  modelName: string | null
  name: string
  provider: string | null
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

export const ensureSelectableModelId = async (selectedModel: EnsureSelectableModel): Promise<string> => {
  const provider = getNormalizedProvider(selectedModel.provider)

  if (!shouldEnsureSelectableModel(selectedModel)) {
    return selectedModel.id
  }

  const modelName = selectedModel.modelName?.trim() ?? ''

  if (!modelName) {
    throw new Error(`Selected ${getProviderDisplayName(provider)} model is missing modelName`)
  }

  const response = await apiClient.api.models.ensure.post({
    modelName,
    name: selectedModel.name,
    provider,
    version: selectedModel.version ?? undefined,
  })
  const result = handleApiResponse<EnsureModelResponse>(
    response as unknown as {data?: EnsureModelResponse; error?: unknown; status?: number},
    `Failed to ensure ${getProviderDisplayName(provider)} model`,
  )

  return result.data.modelId
}
