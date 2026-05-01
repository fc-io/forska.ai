import {getQwen35ThinkingVariant} from './qwen35Thinking.ts'

export const providerModelThinkingOptions = ['disabled', 'enabled', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export type ProviderModelThinkingOption = (typeof providerModelThinkingOptions)[number]

export type ProviderModelOptions = {thinking: ProviderModelThinkingOption | null}

export type ProviderModelSupportedOptions = {thinking: boolean}

const getJsonRecord = (value: unknown): Record<string, unknown> | null => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

const getLegacyThinkingOption = (value: unknown): ProviderModelThinkingOption | null => {
  const legacyVariant = getQwen35ThinkingVariant(typeof value === 'string' ? value : null)

  return legacyVariant === 'thinking' ? 'enabled' : legacyVariant === 'non-thinking' ? 'disabled' : null
}

export const getProviderModelThinkingOption = (value: unknown): ProviderModelThinkingOption | null => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : null

  return normalized && providerModelThinkingOptions.includes(normalized as ProviderModelThinkingOption)
    ? (normalized as ProviderModelThinkingOption)
    : getLegacyThinkingOption(value)
}

export const getProviderModelOptions = (value: unknown): ProviderModelOptions => {
  const metadataRecord = getJsonRecord(value)
  const optionsRecord = getJsonRecord(metadataRecord?.options)
  const directOptionsRecord = getJsonRecord(value)
  const thinking =
    getProviderModelThinkingOption(optionsRecord?.thinking)
    ?? getProviderModelThinkingOption(directOptionsRecord?.thinking)
    ?? getLegacyThinkingOption(metadataRecord?.discovery ? null : metadataRecord?.variant)

  return {thinking}
}

export const getProviderModelSupportedOptions = (value: unknown): ProviderModelSupportedOptions => {
  const metadataRecord = getJsonRecord(value)
  const discovery = getJsonRecord(metadataRecord?.discovery)
  const capabilities = getJsonRecord(discovery?.capabilities)
  const supportedOptions = getJsonRecord(capabilities?.supportedOptions)
  const reasoningEfforts = Array.isArray(capabilities?.reasoningEfforts) ? capabilities.reasoningEfforts : []

  return {thinking: supportedOptions?.thinking === true || reasoningEfforts.length > 0}
}

export const getPersistedProviderModelOptions = (options: ProviderModelOptions): ProviderModelOptions | null => {
  return options.thinking ? options : null
}
