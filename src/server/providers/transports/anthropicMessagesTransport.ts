import {type ProviderInvocationResult, type ProviderListedModel} from '../providerTypes.ts'
import {getRequiredApiKey, getRequiredBaseURL, getTrimmedValue} from './providerTransportUtils.ts'

const anthropicVersion = '2023-06-01'

const getAnthropicHeaders = (apiKey: string): HeadersInit => {
  return {'anthropic-version': anthropicVersion, 'content-type': 'application/json', 'x-api-key': apiKey}
}

export const listAnthropicMessageModels = async ({
  apiKey,
  baseURL,
  providerLabel,
}: {
  apiKey: string | null
  baseURL: string | null
  providerLabel: string
}): Promise<ProviderListedModel[]> => {
  const resolvedBaseURL = getRequiredBaseURL({baseURL, providerLabel})
  const requiredApiKey = getRequiredApiKey({apiKey, providerLabel})
  const response = await fetch(`${resolvedBaseURL}/models`, {headers: getAnthropicHeaders(requiredApiKey)})

  if (!response.ok) {
    throw new Error(`Anthropic list models failed (${response.status})`)
  }

  const body = (await response.json()) as {data?: Array<{display_name?: string; id: string}>}

  return (body.data ?? []).map((model) => {
    const modelId = String(model.id)

    return {
      displayName: getTrimmedValue(model.display_name) ?? modelId,
      metadataJson: model,
      modelName: modelId,
      remoteModelId: modelId,
      variant: null,
      version: null,
    }
  })
}

export const invokeAnthropicMessagesModel = async ({
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
  const resolvedBaseURL = getRequiredBaseURL({baseURL, providerLabel: 'Anthropic'})
  const requiredApiKey = getRequiredApiKey({apiKey, providerLabel: 'Anthropic'})
  const response = await fetch(`${resolvedBaseURL}/messages`, {
    body: JSON.stringify({
      max_tokens: maxCompletionTokens,
      messages: [{content: prompt, role: 'user'}],
      model: modelName,
      system: systemPrompt,
      temperature,
    }),
    headers: getAnthropicHeaders(requiredApiKey),
    method: 'POST',
  })

  if (!response.ok) {
    throw new Error(`Anthropic request failed (${response.status})`)
  }

  const body = (await response.json()) as {
    content?: Array<{text?: string; type?: string}>
    usage?: {input_tokens?: number; output_tokens?: number}
  }
  const text = (body.content ?? [])
    .filter((part) => {
      return part.type === 'text' || typeof part.text === 'string'
    })
    .map((part) => {
      return String(part.text ?? '')
    })
    .join('\n')
  const promptTokens = body.usage?.input_tokens ?? 0
  const completionTokens = body.usage?.output_tokens ?? 0

  return {text, usage: {completionTokens, promptTokens, totalTokens: promptTokens + completionTokens}}
}
