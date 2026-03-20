import {type ProviderInvocationResult, type ProviderListedModel} from '../providerTypes.ts'
import {
  getOpenAIClient,
  getOpenAICompatibleUsage,
  getOpenAIMessageText,
  getRequiredBaseURL,
  getTrimmedValue,
} from './providerTransportUtils.ts'

export const listOpenAIChatModels = async ({
  apiKey,
  baseURL,
  providerLabel,
}: {
  apiKey: string | null
  baseURL: string | null
  providerLabel: string
}): Promise<ProviderListedModel[]> => {
  const resolvedBaseURL = getRequiredBaseURL({baseURL, providerLabel})
  const client = getOpenAIClient({apiKey, baseURL: resolvedBaseURL})
  const response = await client.models.list()

  return response.data.map((model) => {
    const modelId = String(model.id)

    return {
      displayName: modelId,
      metadataJson: model,
      modelName: modelId,
      remoteModelId: modelId,
      variant: null,
      version: null,
    }
  })
}

export const invokeOpenAIChatModel = async ({
  apiKey,
  baseURL,
  maxCompletionTokens,
  modelName,
  prompt,
  systemPrompt,
  temperature,
}: {
  apiKey: string | null
  baseURL: string | null
  maxCompletionTokens: number
  modelName: string
  prompt: string
  systemPrompt: string
  temperature: number
}): Promise<ProviderInvocationResult> => {
  const resolvedBaseURL = getRequiredBaseURL({baseURL, providerLabel: 'Provider'})
  const client = getOpenAIClient({apiKey, baseURL: resolvedBaseURL})
  const response = await client.chat.completions.create({
    max_completion_tokens: maxCompletionTokens,
    messages: [
      {content: systemPrompt, role: 'system'},
      {content: prompt, role: 'user'},
    ],
    model: modelName,
    temperature,
  })
  const message = response.choices[0]?.message

  if (!message) {
    throw new Error('No message in provider response')
  }

  return {text: getOpenAIMessageText(message), usage: getOpenAICompatibleUsage(response.usage)}
}

export const listNativeOllamaModels = async ({baseURL}: {baseURL: string | null}): Promise<ProviderListedModel[]> => {
  const resolvedBaseURL = getRequiredBaseURL({baseURL, providerLabel: 'Ollama'})
  const nativeBaseURL = resolvedBaseURL.endsWith('/v1') ? resolvedBaseURL.slice(0, -3) : resolvedBaseURL
  const response = await fetch(`${nativeBaseURL}/api/tags`)

  if (!response.ok) {
    throw new Error(`Ollama list models failed (${response.status})`)
  }

  const body = (await response.json()) as {
    models?: Array<{model?: string; modified_at?: string; name: string; size?: number}>
  }

  return (body.models ?? []).map((model) => {
    const modelId = getTrimmedValue(model.model) ?? model.name

    return {
      displayName: modelId,
      metadataJson: model,
      modelName: modelId,
      remoteModelId: modelId,
      variant: null,
      version: null,
    }
  })
}
