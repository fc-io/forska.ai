import {type ProviderInvocationResult, type ProviderListedModel} from '../providerTypes.ts'
import {getRequiredApiKey, getRequiredBaseURL, getTrimmedValue} from './providerTransportUtils.ts'

const getGoogleModelName = (modelName: string): string => {
  return modelName.startsWith('models/') ? modelName : `models/${modelName}`
}

export const listGeminiModels = async ({
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
  const response = await fetch(`${resolvedBaseURL}/models?pageSize=200&key=${encodeURIComponent(requiredApiKey)}`)

  if (!response.ok) {
    throw new Error(`Google list models failed (${response.status})`)
  }

  const body = (await response.json()) as {
    models?: Array<{displayName?: string; name: string; supportedGenerationMethods?: string[]}>
  }

  return (body.models ?? [])
    .filter((model) => {
      return (
        Array.isArray(model.supportedGenerationMethods) && model.supportedGenerationMethods.includes('generateContent')
      )
    })
    .map((model) => {
      const modelId = String(model.name)

      return {
        displayName: getTrimmedValue(model.displayName) ?? modelId,
        metadataJson: model,
        modelName: modelId,
        remoteModelId: modelId,
        variant: null,
        version: null,
      }
    })
}

export const invokeGeminiGenerateContentModel = async ({
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
  maxCompletionTokens?: number | null
  modelName: string
  prompt: string
  systemPrompt: string
  temperature: number
}): Promise<ProviderInvocationResult> => {
  const resolvedBaseURL = getRequiredBaseURL({baseURL, providerLabel: 'Google'})
  const requiredApiKey = getRequiredApiKey({apiKey, providerLabel: 'Google'})
  const response = await fetch(
    `${resolvedBaseURL}/${getGoogleModelName(modelName)}:generateContent?key=${encodeURIComponent(requiredApiKey)}`,
    {
      body: JSON.stringify({
        contents: [{parts: [{text: prompt}], role: 'user'}],
        generationConfig: {
          temperature,
          ...(typeof maxCompletionTokens === 'number' ? {maxOutputTokens: maxCompletionTokens} : {}),
        },
        systemInstruction: {parts: [{text: systemPrompt}]},
      }),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    },
  )

  if (!response.ok) {
    throw new Error(`Google request failed (${response.status})`)
  }

  const body = (await response.json()) as {
    candidates?: Array<{content?: {parts?: Array<{text?: string}>}}>
    usageMetadata?: {candidatesTokenCount?: number; promptTokenCount?: number; totalTokenCount?: number}
  }
  const text =
    body.candidates?.[0]?.content?.parts
      ?.map((part) => {
        return String(part.text ?? '')
      })
      .join('\n') ?? ''
  const promptTokens = body.usageMetadata?.promptTokenCount ?? 0
  const completionTokens = body.usageMetadata?.candidatesTokenCount ?? 0
  const totalTokens = body.usageMetadata?.totalTokenCount ?? promptTokens + completionTokens

  return {text, usage: {completionTokens, promptTokens, totalTokens}}
}
