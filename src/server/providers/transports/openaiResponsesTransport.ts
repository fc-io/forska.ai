import {getProviderImageDataUrl, getProviderPromptParts} from '../providerImageInput.ts'
import {type ProviderInvocationResult, type ProviderInvokePrompt, type ProviderListedModel} from '../providerTypes.ts'
import {
  getJsonSchemaTextFormat,
  getOpenAIClient,
  getRequiredApiKey,
  getRequiredBaseURL,
} from './providerTransportUtils.ts'

type OpenAIResponsesContentPart = {text: string; type: 'input_text'} | {image_url: string; type: 'input_image'}

const getOpenAIResponsesUserContent = (prompt: ProviderInvokePrompt): OpenAIResponsesContentPart[] | string => {
  const parts = getProviderPromptParts(prompt)

  return parts.images.length === 0
    ? parts.text
    : [
        {text: parts.text, type: 'input_text'},
        ...parts.images.map((image): OpenAIResponsesContentPart => {
          return {image_url: getProviderImageDataUrl(image), type: 'input_image'}
        }),
      ]
}

export const getOpenAIResponsesRequest = ({
  maxCompletionTokens,
  modelName,
  outputSchema,
  prompt,
  systemPrompt,
  temperature,
}: {
  maxCompletionTokens?: number | null
  modelName: string
  outputSchema: unknown
  prompt: ProviderInvokePrompt
  systemPrompt: string
  temperature: number
}) => {
  return {
    input: [
      {content: systemPrompt, role: 'system'},
      {content: getOpenAIResponsesUserContent(prompt), role: 'user'},
    ],
    model: modelName,
    temperature,
    text: getJsonSchemaTextFormat(outputSchema),
    ...(typeof maxCompletionTokens === 'number' ? {max_output_tokens: maxCompletionTokens} : {}),
  }
}

export const listOpenAIResponseModels = async ({
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
  const client = getOpenAIClient({apiKey: requiredApiKey, baseURL: resolvedBaseURL})
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

export const invokeOpenAIResponsesModel = async ({
  apiKey,
  baseURL,
  maxCompletionTokens,
  modelName,
  outputSchema,
  prompt,
  signal,
  systemPrompt,
  temperature,
}: {
  apiKey: string | null
  baseURL: string | null
  maxCompletionTokens?: number | null
  modelName: string
  outputSchema: unknown
  prompt: ProviderInvokePrompt
  signal?: AbortSignal
  systemPrompt: string
  temperature: number
}): Promise<ProviderInvocationResult> => {
  const resolvedBaseURL = getRequiredBaseURL({baseURL, providerLabel: 'OpenAI API'})
  const requiredApiKey = getRequiredApiKey({apiKey, providerLabel: 'OpenAI API'})
  const client = getOpenAIClient({apiKey: requiredApiKey, baseURL: resolvedBaseURL})
  const response = await client.responses.create(
    getOpenAIResponsesRequest({
      maxCompletionTokens,
      modelName,
      outputSchema,
      prompt,
      systemPrompt,
      temperature,
    }) as never,
    {signal},
  )
  const usage = response.usage

  return {
    text: response.output_text,
    usage: {
      completionTokens: usage?.output_tokens ?? 0,
      promptTokens: usage?.input_tokens ?? 0,
      totalTokens: usage?.total_tokens ?? 0,
    },
  }
}
