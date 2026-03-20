import {type ProviderInvocationResult, type ProviderListedModel} from '../providerTypes.ts'
import {
  getJsonSchemaTextFormat,
  getOpenAIClient,
  getRequiredApiKey,
  getRequiredBaseURL,
} from './providerTransportUtils.ts'

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
  systemPrompt,
  temperature,
}: {
  apiKey: string | null
  baseURL: string | null
  maxCompletionTokens: number
  modelName: string
  outputSchema: unknown
  prompt: string
  systemPrompt: string
  temperature: number
}): Promise<ProviderInvocationResult> => {
  const resolvedBaseURL = getRequiredBaseURL({baseURL, providerLabel: 'OpenAI API'})
  const requiredApiKey = getRequiredApiKey({apiKey, providerLabel: 'OpenAI API'})
  const client = getOpenAIClient({apiKey: requiredApiKey, baseURL: resolvedBaseURL})
  const response = await client.responses.create({
    input: [
      {content: systemPrompt, role: 'system'},
      {content: prompt, role: 'user'},
    ],
    max_output_tokens: maxCompletionTokens,
    model: modelName,
    temperature,
    text: getJsonSchemaTextFormat(outputSchema),
  } as never)
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
