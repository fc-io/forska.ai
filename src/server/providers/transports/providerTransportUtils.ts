import OpenAI from 'openai'
import type {ChatCompletionMessage} from 'openai/resources/chat/completions'

import {type ProviderCatalogEntry} from '../../services/providerCatalog.ts'

const openAIClients = new Map<string, OpenAI>()

export type OpenAICompatibleUsage = {completionTokens: number; promptTokens: number; totalTokens: number}

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
    | {completion_tokens?: number | null; prompt_tokens?: number | null; total_tokens?: number | null}
    | null
    | undefined,
): OpenAICompatibleUsage => {
  return {
    completionTokens: usage?.completion_tokens ?? 0,
    promptTokens: usage?.prompt_tokens ?? 0,
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
