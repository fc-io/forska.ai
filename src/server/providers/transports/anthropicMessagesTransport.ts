import {getAnthropicThinkingConfig} from '../../../utils/anthropicThinking.ts'
import {ProviderInvocationError, type ProviderInvocationResult, type ProviderListedModel} from '../providerTypes.ts'
import {
  getAnthropicJsonSchemaOutputConfig,
  getRequiredApiKey,
  getRequiredBaseURL,
  getTrimmedValue,
} from './providerTransportUtils.ts'

const anthropicVersion = '2023-06-01'
const anthropicPauseTurnLimit = 8
const anthropicEmptyResponseFailureCode = 'anthropic_empty_response'
const anthropicRefusalEmptyResponseFailureCode = 'anthropic_refusal_empty_response'
const anthropicThinkingOnlyEmptyResponseFailureCode = 'anthropic_thinking_only_empty_response'

type AnthropicErrorResponse = {error?: {message?: string; type?: string}; request_id?: string}
type AnthropicContentBlock = {text?: string; type?: string; [key: string]: unknown}
type AnthropicMessage = {content: AnthropicContentBlock[] | string; role: 'assistant' | 'user'}
type AnthropicMessageResponseBody = {
  content?: AnthropicContentBlock[]
  stop_reason?: string | null
  usage?: {input_tokens?: number; output_tokens?: number}
}
type AnthropicInvocationRunResult = {
  content: AnthropicContentBlock[]
  stopReason: string | null
  text: string
  usage: {completionTokens: number; promptTokens: number; totalTokens: number}
}

const getAnthropicHeaders = (apiKey: string): HeadersInit => {
  return {'anthropic-version': anthropicVersion, 'content-type': 'application/json', 'x-api-key': apiKey}
}

const getAnthropicResponseText = (content: AnthropicContentBlock[]): string => {
  return content
    .filter((part) => {
      return part.type === 'text' || typeof part.text === 'string'
    })
    .map((part) => {
      return String(part.text ?? '')
    })
    .join('\n')
}

const getAnthropicContentTypes = (content: AnthropicContentBlock[]): string[] => {
  return content.map((part) => {
    return typeof part.type === 'string' && part.type.trim().length > 0 ? part.type : 'unknown'
  })
}

const isAnthropicThinkingOnlyContent = (contentTypes: string[]): boolean => {
  return (
    contentTypes.length > 0
    && contentTypes.every((type) => {
      return type === 'thinking' || type === 'redacted_thinking'
    })
  )
}

const shouldIncludeAnthropicTemperature = (modelName: string): boolean => {
  const normalizedModelName = getTrimmedValue(modelName)?.toLowerCase() ?? ''

  return !normalizedModelName.startsWith('claude-opus-4-7')
}

const getAnthropicMaxOutputTokens = (modelName: string): number | null => {
  const normalizedModelName = getTrimmedValue(modelName)?.toLowerCase() ?? ''

  return normalizedModelName.startsWith('claude-opus-4-7') || normalizedModelName.startsWith('claude-opus-4-6')
    ? 128000
    : normalizedModelName.startsWith('claude-sonnet-4-6')
      ? 64000
      : null
}

const getAnthropicMessagesRequestBody = ({
  maxCompletionTokens,
  messages,
  modelName,
  outputSchema,
  systemPrompt,
  temperature,
  thinkingVersion,
}: {
  maxCompletionTokens: number
  messages: AnthropicMessage[]
  modelName: string
  outputSchema: unknown
  systemPrompt: string
  temperature: number
  thinkingVersion: string | null
}) => {
  const thinkingConfig = getAnthropicThinkingConfig({modelName, version: thinkingVersion})
  const resolvedMaxCompletionTokens = thinkingConfig
    ? Math.max(maxCompletionTokens, getAnthropicMaxOutputTokens(modelName) ?? maxCompletionTokens)
    : maxCompletionTokens
  const requestBody = {
    max_tokens: resolvedMaxCompletionTokens,
    messages,
    model: modelName,
    output_config: {...getAnthropicJsonSchemaOutputConfig(outputSchema), ...(thinkingConfig?.outputConfig ?? {})},
    system: systemPrompt,
    ...(thinkingConfig ? {thinking: thinkingConfig.thinking} : {}),
  }

  return shouldIncludeAnthropicTemperature(modelName) ? {...requestBody, temperature} : requestBody
}

const invokeAnthropicMessagesRun = async ({
  apiKey,
  baseURL,
  maxCompletionTokens,
  modelName,
  outputSchema,
  prompt,
  systemPrompt,
  temperature,
  thinkingVersion,
}: {
  apiKey: string
  baseURL: string
  maxCompletionTokens: number
  modelName: string
  outputSchema: unknown
  prompt: string
  systemPrompt: string
  temperature: number
  thinkingVersion: string | null
}): Promise<AnthropicInvocationRunResult> => {
  const messages: AnthropicMessage[] = [{content: prompt, role: 'user'}]
  let completionTokens = 0
  let promptTokens = 0
  let text = ''
  let pauseTurns = 0

  while (pauseTurns <= anthropicPauseTurnLimit) {
    const response = await fetch(`${baseURL}/messages`, {
      body: JSON.stringify(
        getAnthropicMessagesRequestBody({
          maxCompletionTokens,
          messages,
          modelName,
          outputSchema,
          systemPrompt,
          temperature,
          thinkingVersion,
        }),
      ),
      headers: getAnthropicHeaders(apiKey),
      method: 'POST',
    })

    if (!response.ok) {
      throw new Error(await getAnthropicResponseErrorMessage({action: 'request', response}))
    }

    const body = (await response.json()) as AnthropicMessageResponseBody
    const content = body.content ?? []
    const responseText = getAnthropicResponseText(content)
    const stopReason = body.stop_reason ?? null

    promptTokens += body.usage?.input_tokens ?? 0
    completionTokens += body.usage?.output_tokens ?? 0
    text += responseText

    if (stopReason !== 'pause_turn') {
      return {
        content,
        stopReason,
        text,
        usage: {completionTokens, promptTokens, totalTokens: promptTokens + completionTokens},
      }
    }

    messages.push({content, role: 'assistant'})
    pauseTurns += 1
  }

  throw new Error(`Anthropic request exceeded pause_turn continuation limit (${String(anthropicPauseTurnLimit)})`)
}

const getAnthropicEmptyResponseDiagnostics = ({
  attempt,
  modelName,
  result,
  version,
}: {
  attempt: 'initial'
  modelName: string
  result: AnthropicInvocationRunResult
  version: string | null
}) => {
  return {
    attempt,
    contentTypes: getAnthropicContentTypes(result.content),
    modelName,
    stopReason: result.stopReason,
    textLength: result.text.length,
    thinkingVersion: version,
  }
}

const getAnthropicEmptyResponseFailureCode = (
  diagnostics: ReturnType<typeof getAnthropicEmptyResponseDiagnostics>,
): string => {
  return diagnostics.stopReason === 'refusal'
    ? anthropicRefusalEmptyResponseFailureCode
    : isAnthropicThinkingOnlyContent(diagnostics.contentTypes)
      ? anthropicThinkingOnlyEmptyResponseFailureCode
      : anthropicEmptyResponseFailureCode
}

const throwAnthropicEmptyResponseError = ({
  initialDiagnostics,
  usage,
}: {
  initialDiagnostics: ReturnType<typeof getAnthropicEmptyResponseDiagnostics>
  usage: AnthropicInvocationRunResult['usage']
}): never => {
  const diagnostics = {fallback: null, initial: initialDiagnostics}
  const failureCode = getAnthropicEmptyResponseFailureCode(initialDiagnostics)

  console.error('[anthropic] structured output returned no text content', diagnostics)

  throw new ProviderInvocationError(
    `Anthropic returned no text content (failure_code=${failureCode}; stop_reason=${String(initialDiagnostics.stopReason ?? 'null')}; content_types=${initialDiagnostics.contentTypes.join(',') || 'none'})`,
    {code: failureCode, diagnostics, providerKind: 'anthropic', usage},
  )
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
  const initialResult = await invokeAnthropicMessagesRun({
    apiKey: requiredApiKey,
    baseURL: resolvedBaseURL,
    maxCompletionTokens,
    modelName,
    outputSchema,
    prompt,
    systemPrompt,
    temperature,
    thinkingVersion: version,
  })
  const initialDiagnostics = getAnthropicEmptyResponseDiagnostics({
    attempt: 'initial',
    modelName,
    result: initialResult,
    version,
  })

  if (initialResult.text.length === 0) {
    throwAnthropicEmptyResponseError({initialDiagnostics, usage: initialResult.usage})
  }

  return {stopReason: initialResult.stopReason, text: initialResult.text, usage: initialResult.usage}
}
