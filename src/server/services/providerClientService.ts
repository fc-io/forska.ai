import OpenAI from 'openai'
import type {ChatCompletionMessage} from 'openai/resources/chat/completions'

import {getCodexAppServerClient} from '../utils/getCodexAppServerClient.ts'
import {
  getProviderCatalogEntry,
  getProviderDefaultBaseURL,
  isAnthropicProvider,
  isCodexProvider,
  isGoogleProvider,
  isOpenAICompatibleProvider,
  normalizeProviderKind,
} from './providerCatalog.ts'
import {getProviderSecretValue} from './providerSecretStore.ts'

const anthropicVersion = '2023-06-01'
const openAIClients = new Map<string, OpenAI>()

export type ProviderConnectionTestResult = {message: string; modelCount: number | null}

export type ProviderInvocationResult = {
  text: string
  usage: {completionTokens: number; promptTokens: number; totalTokens: number}
}

export type ProviderListModelsInput = {
  baseURL: string | null
  providerKind: string | null | undefined
  secretRef: string | null
}

export type ProviderInvokeInput = {
  baseURL: string
  maxCompletionTokens: number
  modelName: string
  outputSchema: unknown
  prompt: string
  providerKind: string | null | undefined
  secretRef: string | null
  systemPrompt: string
  temperature: number
  version: string | null
}

export type ProviderListedModel = {
  displayName: string
  metadataJson: unknown
  modelName: string
  remoteModelId: string
  variant: string | null
  version: string | null
}

const getTrimmedValue = (value: string | null | undefined): string | null => {
  const normalized = String(value ?? '').trim()

  return normalized === '' ? null : normalized
}

const normalizeBaseURL = (value: string | null | undefined): string | null => {
  const trimmed = getTrimmedValue(value)

  return trimmed ? trimmed.replace(/\/+$/, '') : null
}

const getResolvedBaseURL = ({
  baseURL,
  providerKind,
}: {
  baseURL: string | null
  providerKind: string | null | undefined
}): string | null => {
  return normalizeBaseURL(baseURL) ?? normalizeBaseURL(getProviderDefaultBaseURL(providerKind))
}

const getRequiredBaseURL = ({
  baseURL,
  providerKind,
}: {
  baseURL: string | null
  providerKind: string | null | undefined
}): string => {
  const resolved = getResolvedBaseURL({baseURL, providerKind})

  if (!resolved) {
    throw new Error(`${getProviderCatalogEntry(providerKind)?.label ?? 'Provider'} base URL is required`)
  }

  return resolved
}

const getRequiredSecret = async ({
  providerKind,
  secretRef,
}: {
  providerKind: string | null | undefined
  secretRef: string | null
}) => {
  const secret = await getProviderSecretValue(secretRef)

  if (!secret && getProviderCatalogEntry(providerKind)?.requiresApiKey) {
    throw new Error(`${getProviderCatalogEntry(providerKind)?.label ?? 'Provider'} API key is required`)
  }

  return secret
}

const getOpenAIClient = ({apiKey, baseURL}: {apiKey: string | null; baseURL: string}): OpenAI => {
  const cacheKey = `${baseURL}::${apiKey ?? ''}`
  const existingClient = openAIClients.get(cacheKey)

  if (existingClient) {
    return existingClient
  }

  const client = new OpenAI({
    apiKey: apiKey ?? 'fake_key',
    dangerouslyAllowBrowser: true,
    baseURL,
    maxRetries: 0,
    timeout: 900_000,
  })

  openAIClients.set(cacheKey, client)

  return client
}

const getOpenAIMessageText = (message: ChatCompletionMessage): string => {
  const parts = Array.isArray(message.content) ? (message.content as Array<{text?: unknown}>) : []
  const textContent =
    typeof message.content === 'string'
      ? message.content
      : parts.length > 0
        ? parts
            .map((part) => {
              return typeof part.text === 'string' ? part.text : ''
            })
            .join('\n')
        : ''
  const reasoningContent =
    typeof (message as {reasoning_content?: unknown}).reasoning_content === 'string'
      ? ((message as {reasoning_content?: string}).reasoning_content ?? '')
      : ''

  return textContent || reasoningContent || ''
}

const listOpenAICompatibleModels = async ({
  baseURL,
  providerKind,
  secretRef,
}: ProviderListModelsInput): Promise<ProviderListedModel[]> => {
  const resolvedBaseURL = getRequiredBaseURL({baseURL, providerKind})
  const apiKey = await getRequiredSecret({providerKind, secretRef})
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

const listCodexModels = async (): Promise<ProviderListedModel[]> => {
  const client = getCodexAppServerClient()
  const {data} = await client.modelList({limit: 200, includeHidden: false, cursor: null})

  return data
    .filter((model) => {
      return !model.hidden
    })
    .flatMap((model) => {
      const modelName = String(model.id).trim()
      const baseName = String(model.displayName ?? model.id).trim() || modelName
      const efforts = Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : []
      const autoModel = {
        displayName: `${baseName} (thinking: auto)`,
        metadataJson: model,
        modelName,
        remoteModelId: modelName,
        variant: null,
        version: null,
      }
      const variants = efforts
        .map((effortEntry) => {
          const effort = String(effortEntry.reasoningEffort ?? '').trim()

          return effort
            ? {
                displayName: `${baseName} (thinking: ${effort})`,
                metadataJson: {...model, reasoningEffort: effort},
                modelName,
                remoteModelId: modelName,
                variant: effort,
                version: effort,
              }
            : null
        })
        .filter((entry): entry is NonNullable<typeof entry> => {
          return Boolean(entry)
        })

      return [autoModel, ...variants]
    })
}

const getAnthropicHeaders = (apiKey: string): HeadersInit => {
  return {'anthropic-version': anthropicVersion, 'content-type': 'application/json', 'x-api-key': apiKey}
}

const listAnthropicModels = async ({
  baseURL,
  providerKind,
  secretRef,
}: ProviderListModelsInput): Promise<ProviderListedModel[]> => {
  const resolvedBaseURL = getRequiredBaseURL({baseURL, providerKind})
  const apiKey = await getRequiredSecret({providerKind, secretRef})

  if (!apiKey) {
    throw new Error('Anthropic API key is required')
  }

  const response = await fetch(`${resolvedBaseURL}/models`, {headers: getAnthropicHeaders(apiKey)})

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

const getGoogleModelName = (modelName: string): string => {
  return modelName.startsWith('models/') ? modelName : `models/${modelName}`
}

const listGoogleModels = async ({
  baseURL,
  providerKind,
  secretRef,
}: ProviderListModelsInput): Promise<ProviderListedModel[]> => {
  const resolvedBaseURL = getRequiredBaseURL({baseURL, providerKind})
  const apiKey = await getRequiredSecret({providerKind, secretRef})

  if (!apiKey) {
    throw new Error('Google API key is required')
  }

  const response = await fetch(`${resolvedBaseURL}/models?pageSize=200&key=${encodeURIComponent(apiKey)}`)

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

const invokeCodexModel = async ({
  modelName,
  outputSchema,
  prompt,
  systemPrompt,
  version,
}: ProviderInvokeInput): Promise<ProviderInvocationResult> => {
  const client = getCodexAppServerClient()
  const result = await client.runJsonTurn({
    effort: version,
    inputText: `${systemPrompt}\n\n${prompt}`,
    model: modelName,
    outputSchema,
    timeoutMs: 900_000,
  })

  return {text: result.text, usage: {completionTokens: 0, promptTokens: 0, totalTokens: 0}}
}

const invokeOpenAICompatibleModel = async ({
  baseURL,
  maxCompletionTokens,
  modelName,
  prompt,
  providerKind,
  secretRef,
  systemPrompt,
  temperature,
}: ProviderInvokeInput): Promise<ProviderInvocationResult> => {
  const apiKey = await getRequiredSecret({providerKind, secretRef})
  const client = getOpenAIClient({apiKey, baseURL})
  const response = await client.chat.completions.create({
    max_completion_tokens: maxCompletionTokens,
    messages: [
      {role: 'system', content: systemPrompt},
      {role: 'user', content: prompt},
    ],
    model: modelName,
    temperature,
  })
  const message = response.choices[0]?.message

  if (!message) {
    throw new Error('No message in provider response')
  }

  return {
    text: getOpenAIMessageText(message),
    usage: {
      completionTokens: response.usage?.completion_tokens ?? 0,
      promptTokens: response.usage?.prompt_tokens ?? 0,
      totalTokens: response.usage?.total_tokens ?? 0,
    },
  }
}

const invokeAnthropicModel = async ({
  baseURL,
  maxCompletionTokens,
  modelName,
  prompt,
  providerKind,
  secretRef,
  systemPrompt,
  temperature,
}: ProviderInvokeInput): Promise<ProviderInvocationResult> => {
  const apiKey = await getRequiredSecret({providerKind, secretRef})

  if (!apiKey) {
    throw new Error('Anthropic API key is required')
  }

  const response = await fetch(`${baseURL}/messages`, {
    body: JSON.stringify({
      max_tokens: maxCompletionTokens,
      messages: [{content: prompt, role: 'user'}],
      model: modelName,
      system: systemPrompt,
      temperature,
    }),
    headers: getAnthropicHeaders(apiKey),
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

const invokeGoogleModel = async ({
  baseURL,
  maxCompletionTokens,
  modelName,
  prompt,
  providerKind,
  secretRef,
  systemPrompt,
  temperature,
}: ProviderInvokeInput): Promise<ProviderInvocationResult> => {
  const apiKey = await getRequiredSecret({providerKind, secretRef})

  if (!apiKey) {
    throw new Error('Google API key is required')
  }

  const response = await fetch(
    `${baseURL}/${getGoogleModelName(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      body: JSON.stringify({
        contents: [{parts: [{text: prompt}], role: 'user'}],
        generationConfig: {maxOutputTokens: maxCompletionTokens, temperature},
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

export const listProviderModels = async ({
  baseURL,
  providerKind,
  secretRef,
}: ProviderListModelsInput): Promise<ProviderListedModel[]> => {
  const normalizedProviderKind = normalizeProviderKind(providerKind)

  return isCodexProvider(normalizedProviderKind)
    ? listCodexModels()
    : isAnthropicProvider(normalizedProviderKind)
      ? listAnthropicModels({baseURL, providerKind: normalizedProviderKind, secretRef})
      : isGoogleProvider(normalizedProviderKind)
        ? listGoogleModels({baseURL, providerKind: normalizedProviderKind, secretRef})
        : listOpenAICompatibleModels({baseURL, providerKind: normalizedProviderKind, secretRef})
}

export const testProviderConnection = async ({
  baseURL,
  providerKind,
  secretRef,
}: ProviderListModelsInput): Promise<ProviderConnectionTestResult> => {
  const models = await listProviderModels({baseURL, providerKind, secretRef})
  const label = getProviderCatalogEntry(providerKind)?.label ?? 'Provider'

  return {
    message: `${label} connected${models.length > 0 ? ` (${models.length} models)` : ''}`,
    modelCount: models.length,
  }
}

export const invokeProviderModel = async (input: ProviderInvokeInput): Promise<ProviderInvocationResult> => {
  const normalizedProviderKind = normalizeProviderKind(input.providerKind)
  const resolvedBaseURL = getRequiredBaseURL({baseURL: input.baseURL, providerKind: normalizedProviderKind})

  return isCodexProvider(normalizedProviderKind)
    ? invokeCodexModel({...input, baseURL: resolvedBaseURL, providerKind: normalizedProviderKind})
    : isAnthropicProvider(normalizedProviderKind)
      ? invokeAnthropicModel({...input, baseURL: resolvedBaseURL, providerKind: normalizedProviderKind})
      : isGoogleProvider(normalizedProviderKind)
        ? invokeGoogleModel({...input, baseURL: resolvedBaseURL, providerKind: normalizedProviderKind})
        : isOpenAICompatibleProvider(normalizedProviderKind)
          ? invokeOpenAICompatibleModel({...input, baseURL: resolvedBaseURL, providerKind: normalizedProviderKind})
          : invokeOpenAICompatibleModel({...input, baseURL: resolvedBaseURL, providerKind: normalizedProviderKind})
}

export const getProviderClientService = () => {
  return {invokeProviderModel, listProviderModels, testProviderConnection}
}
