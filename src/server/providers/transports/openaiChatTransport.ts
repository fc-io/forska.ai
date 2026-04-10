import {getProviderModelOptions, type ProviderModelOptions} from '../../../utils/providerModelOptions.ts'
import {isQwen35Model} from '../../../utils/qwen35Thinking.ts'
import {type ProviderInvocationResult, type ProviderListedModel} from '../providerTypes.ts'
import {
  getJsonSchemaResponseFormat,
  getOpenAIClient,
  getOpenAICompatibleUsage,
  getOpenAIMessageText,
  getRequiredBaseURL,
  getTrimmedValue,
} from './providerTransportUtils.ts'

export {isQwen35Model} from '../../../utils/qwen35Thinking.ts'

type OpenAIChatCompletionRequest = {
  chat_template_kwargs?: {enable_thinking: boolean}
  max_completion_tokens: number
  messages: Array<{content: string; role: 'system' | 'user'}>
  model: string
  presence_penalty?: number
  response_format: ReturnType<typeof getJsonSchemaResponseFormat>
  temperature: number
  top_k?: number
  top_p?: number
}

const getQwen35SamplingConfig = (): Pick<
  OpenAIChatCompletionRequest,
  'presence_penalty' | 'temperature' | 'top_k' | 'top_p'
> => {
  return {presence_penalty: 2.0, temperature: 1.0, top_k: 40, top_p: 1.0}
}

export const getOpenAIListedModels = ({
  metadataJson,
  modelName,
}: {
  metadataJson: unknown
  modelName: string
}): ProviderListedModel[] => {
  return [{displayName: modelName, metadataJson, modelName, remoteModelId: modelName, variant: null, version: null}]
}

export const getOpenAIChatCompletionRequest = ({
  maxCompletionTokens,
  modelOptions,
  modelName,
  outputSchema,
  prompt,
  systemPrompt,
  temperature,
}: {
  maxCompletionTokens: number
  modelOptions?: ProviderModelOptions | null
  modelName: string
  outputSchema: unknown
  prompt: string
  systemPrompt: string
  temperature: number
}): OpenAIChatCompletionRequest => {
  const defaultRequest = {
    max_completion_tokens: maxCompletionTokens,
    messages: [
      {content: systemPrompt, role: 'system' as const},
      {content: prompt, role: 'user' as const},
    ],
    model: modelName,
    response_format: getJsonSchemaResponseFormat(outputSchema),
    temperature,
  }
  const thinking = getProviderModelOptions(modelOptions).thinking

  return isQwen35Model(modelName)
    ? {...defaultRequest, ...getQwen35SamplingConfig(), chat_template_kwargs: {enable_thinking: thinking === 'enabled'}}
    : defaultRequest
}

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

  return response.data.flatMap((model) => {
    const modelId = String(model.id)

    return getOpenAIListedModels({metadataJson: model, modelName: modelId})
  })
}

export const invokeOpenAIChatModel = async ({
  apiKey,
  baseURL,
  maxCompletionTokens,
  modelOptions,
  modelName,
  outputSchema,
  prompt,
  systemPrompt,
  temperature,
}: {
  apiKey: string | null
  baseURL: string | null
  maxCompletionTokens: number
  modelOptions?: ProviderModelOptions | null
  modelName: string
  outputSchema: unknown
  prompt: string
  systemPrompt: string
  temperature: number
}): Promise<ProviderInvocationResult> => {
  const resolvedBaseURL = getRequiredBaseURL({baseURL, providerLabel: 'Provider'})
  const client = getOpenAIClient({apiKey, baseURL: resolvedBaseURL})
  const response = await client.chat.completions.create(
    getOpenAIChatCompletionRequest({
      maxCompletionTokens,
      modelOptions,
      modelName,
      outputSchema,
      prompt,
      systemPrompt,
      temperature,
    }) as never,
  )
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
