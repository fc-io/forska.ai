import {getAnthropicThinkingConfig} from '../../../utils/anthropicThinking.ts'
import {type ProviderInvocationResult, type ProviderListedModel} from '../providerTypes.ts'
import {
  getAnthropicJsonSchemaOutputConfig,
  getRequiredApiKey,
  getRequiredBaseURL,
  getTrimmedValue,
} from './providerTransportUtils.ts'

const anthropicVersion = '2023-06-01'

type AnthropicErrorResponse = {error?: {message?: string; type?: string}; request_id?: string}

const getAnthropicHeaders = (apiKey: string): HeadersInit => {
  return {'anthropic-version': anthropicVersion, 'content-type': 'application/json', 'x-api-key': apiKey}
}

const shouldIncludeAnthropicTemperature = (modelName: string): boolean => {
  const normalizedModelName = getTrimmedValue(modelName)?.toLowerCase() ?? ''

  return !normalizedModelName.startsWith('claude-opus-4-7')
}

const getAnthropicMessagesRequestBody = ({
  maxCompletionTokens,
  modelName,
  outputSchema,
  prompt,
  systemPrompt,
  temperature,
  version,
}: {
  maxCompletionTokens: number
  modelName: string
  outputSchema: unknown
  prompt: string
  systemPrompt: string
  temperature: number
  version: string | null
}) => {
  const thinkingConfig = getAnthropicThinkingConfig({modelName, version})
  const requestBody = {
    max_tokens: maxCompletionTokens,
    messages: [{content: prompt, role: 'user' as const}],
    model: modelName,
    output_config: {...getAnthropicJsonSchemaOutputConfig(outputSchema), ...(thinkingConfig?.outputConfig ?? {})},
    system: systemPrompt,
    ...(thinkingConfig ? {thinking: thinkingConfig.thinking} : {}),
  }

  return shouldIncludeAnthropicTemperature(modelName) ? {...requestBody, temperature} : requestBody
}

const getAnthropicResponseErrorMessage = async ({
  action,
  response,
}: {
  action: 'list models' | 'request'
  response: Response
}): Promise<string> => {
  const parsedBody = (await response
    .clone()
    .json()
    .catch(() => {
      return null
    })) as AnthropicErrorResponse | null
  const fallbackText = getTrimmedValue(
    await response.text().catch(() => {
      return ''
    }),
  )
  const errorType = getTrimmedValue(parsedBody?.error?.type)
  const errorMessage = getTrimmedValue(parsedBody?.error?.message) ?? fallbackText
  const requestId = getTrimmedValue(response.headers.get('request-id')) ?? getTrimmedValue(parsedBody?.request_id)
  const detail = [errorType ? `[${errorType}]` : null, errorMessage, requestId ? `request_id=${requestId}` : null]
    .filter((value): value is string => {
      return value !== null
    })
    .join(' ')

  return detail
    ? `Anthropic ${action} failed (${response.status}): ${detail}`
    : `Anthropic ${action} failed (${response.status})`
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
    throw new Error(await getAnthropicResponseErrorMessage({action: 'list models', response}))
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
  outputSchema,
  prompt,
  systemPrompt,
  temperature,
  version,
}: {
  apiKey: string | null
  baseURL: string | null
  maxCompletionTokens: number
  modelName: string
  outputSchema: unknown
  prompt: string
  systemPrompt: string
  temperature: number
  version: string | null
}): Promise<ProviderInvocationResult> => {
  const resolvedBaseURL = getRequiredBaseURL({baseURL, providerLabel: 'Anthropic'})
  const requiredApiKey = getRequiredApiKey({apiKey, providerLabel: 'Anthropic'})
  const response = await fetch(`${resolvedBaseURL}/messages`, {
    body: JSON.stringify(
      getAnthropicMessagesRequestBody({
        maxCompletionTokens,
        modelName,
        outputSchema,
        prompt,
        systemPrompt,
        temperature,
        version,
      }),
    ),
    headers: getAnthropicHeaders(requiredApiKey),
    method: 'POST',
  })

  if (!response.ok) {
    throw new Error(await getAnthropicResponseErrorMessage({action: 'request', response}))
  }

  const body = (await response.json()) as {
    content?: Array<{text?: string; type?: string}>
    stop_reason?: string | null
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

  return {
    stopReason: body.stop_reason ?? null,
    text,
    usage: {completionTokens, promptTokens, totalTokens: promptTokens + completionTokens},
  }
}
