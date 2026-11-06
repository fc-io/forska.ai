import OpenAI from 'openai'
import type {ChatCompletionMessage} from 'openai/resources/chat/completions'

import {type ProviderCatalogEntry} from '../../services/providerCatalog.ts'

const openAIClients = new Map<string, OpenAI>()

export type OpenAICompatibleUsage = {
  cacheCreationInputTokens: null
  cacheReadInputTokens: number | null
  completionTokens: number
  promptTokens: number
  thinkingTokens: number | null
  totalTokens: number
}

export const getReportedTokenCountOrNull = (value: unknown): number | null => {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

export const getTrimmedValue = (value: string | null | undefined): string | null => {
  const normalized = String(value ?? '').trim()

  return normalized === '' ? null : normalized
}

export const normalizeBaseURL = (value: string | null | undefined): string | null => {
  const trimmed = getTrimmedValue(value)

  return trimmed ? trimmed.replace(/\/+$/, '') : null
}

export const getRequiredBaseURL = ({
  baseURL,
  providerLabel,
}: {
  baseURL: string | null | undefined
  providerLabel: string
}): string => {
  const resolvedBaseURL = normalizeBaseURL(baseURL)

  if (!resolvedBaseURL) {
    throw new Error(`${providerLabel} base URL is required`)
  }

  return resolvedBaseURL
}

export const getProviderLabel = (catalog: ProviderCatalogEntry): string => {
  return catalog.label
}

export const getRequiredApiKey = ({
  apiKey,
  providerLabel,
}: {
  apiKey: string | null | undefined
  providerLabel: string
}): string => {
  const normalizedApiKey = getTrimmedValue(apiKey)

  if (!normalizedApiKey) {
    throw new Error(`${providerLabel} API key is required`)
  }

  return normalizedApiKey
}

export const getOpenAIClient = ({apiKey, baseURL}: {apiKey: string | null; baseURL: string}): OpenAI => {
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

export const getOpenAIMessageText = (message: ChatCompletionMessage): string => {
  const parts = Array.isArray(message.content) ? (message.content as Array<{text?: unknown}>) : []
  return typeof message.content === 'string'
    ? message.content
    : parts.length > 0
      ? parts
          .map((part) => {
            return typeof part.text === 'string' ? part.text : ''
          })
          .join('\n')
      : ''
}

export const getOpenAICompatibleUsage = (
  usage:
    | {
        completion_tokens?: number | null
        completion_tokens_details?: {reasoning_tokens?: number | null} | null
        prompt_tokens?: number | null
        prompt_tokens_details?: {cached_tokens?: number | null} | null
        total_tokens?: number | null
      }
    | null
    | undefined,
): OpenAICompatibleUsage => {
  return {
    cacheCreationInputTokens: null,
    cacheReadInputTokens: getReportedTokenCountOrNull(usage?.prompt_tokens_details?.cached_tokens),
    completionTokens: usage?.completion_tokens ?? 0,
    promptTokens: usage?.prompt_tokens ?? 0,
    thinkingTokens: getReportedTokenCountOrNull(usage?.completion_tokens_details?.reasoning_tokens),
    totalTokens: usage?.total_tokens ?? 0,
  }
}

export const getJsonSchemaResponseFormat = (outputSchema: unknown) => {
  return {json_schema: {name: 'structured_output', schema: outputSchema, strict: true}, type: 'json_schema'} as const
}

export const getJsonSchemaTextFormat = (outputSchema: unknown) => {
  return {format: {name: 'structured_output', schema: outputSchema, strict: true, type: 'json_schema'}} as const
}

export const getAnthropicJsonSchemaOutputConfig = (outputSchema: unknown) => {
  return {format: {schema: outputSchema, type: 'json_schema'}} as const
}
