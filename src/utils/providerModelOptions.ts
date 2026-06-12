import {getQwen35ThinkingVariant, isQwen35Model} from './qwen35Thinking.ts'

export const providerModelThinkingOptions = ['disabled', 'enabled', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export const providerModelThinkingModeOptions = ['disabled', 'enabled'] as const
export const providerModelReasoningOptionProviderKinds = ['ollama', 'llmstudio', 'llamacpp', 'sglang', 'vllm'] as const

export type ProviderModelThinkingOption = (typeof providerModelThinkingOptions)[number]
export type ProviderModelThinkingMode = (typeof providerModelThinkingModeOptions)[number]

export type ProviderModelOptions = {
  thinking?: ProviderModelThinkingOption | null
  thinkingMode?: ProviderModelThinkingMode | null
}

export type ProviderModelSupportedOptions = {thinking: boolean}

const getJsonRecord = (value: unknown): Record<string, unknown> | null => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

const getTrimmedValue = (value: unknown): string | null => {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

const getNormalizedProviderKind = (value: string | null | undefined): string => {
  return String(value ?? '')
    .trim()
    .toLowerCase()
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

export const getProviderModelThinkingMode = (value: unknown): ProviderModelThinkingMode | null => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : null

  return normalized && providerModelThinkingModeOptions.includes(normalized as ProviderModelThinkingMode)
    ? (normalized as ProviderModelThinkingMode)
    : null
}

export const supportsProviderModelReasoningOptions = (provider: string | null | undefined): boolean => {
  return providerModelReasoningOptionProviderKinds.includes(
    getNormalizedProviderKind(provider) as (typeof providerModelReasoningOptionProviderKinds)[number],
  )
}

export const getProviderModelOptionsVariant = (options: ProviderModelOptions | null | undefined): string | null => {
  const reasoning = getProviderModelThinkingOption(options?.thinking)
  const reasoningEffort = reasoning && reasoning !== 'enabled' && reasoning !== 'disabled' ? reasoning : null
  const thinkingMode = getProviderModelThinkingMode(options?.thinkingMode)
  const parts = [
    reasoningEffort ? `reasoning-${reasoningEffort}` : null,
    thinkingMode ? `thinking-${thinkingMode}` : null,
  ].filter((part): part is string => {
    return Boolean(part)
  })

  return parts.length > 0 ? parts.join('--') : null
}

export const getProviderModelEffectiveVariant = ({
  options,
  provider,
  remoteModelId,
  variant,
}: {
  options?: ProviderModelOptions | null
  provider: string | null | undefined
  remoteModelId?: string | null
  variant?: string | null
}): string | null => {
  const normalizedVariant = getTrimmedValue(variant)

  return (
    normalizedVariant
    ?? (supportsProviderModelReasoningOptions(provider) && !isQwen35Model(String(remoteModelId ?? ''))
      ? getProviderModelOptionsVariant(options)
      : null)
  )
}

export const getProviderModelOptions = (value: unknown): ProviderModelOptions => {
  const metadataRecord = getJsonRecord(value)
  const optionsRecord = getJsonRecord(metadataRecord?.options)
  const directOptionsRecord = getJsonRecord(value)
  const thinking =
    getProviderModelThinkingOption(optionsRecord?.thinking)
    ?? getProviderModelThinkingOption(directOptionsRecord?.thinking)
    ?? getLegacyThinkingOption(metadataRecord?.discovery ? null : metadataRecord?.variant)
  const thinkingMode =
    getProviderModelThinkingMode(optionsRecord?.thinkingMode)
    ?? getProviderModelThinkingMode(optionsRecord?.thinking_mode)
    ?? getProviderModelThinkingMode(directOptionsRecord?.thinkingMode)
    ?? getProviderModelThinkingMode(directOptionsRecord?.thinking_mode)

  return {...(thinkingMode ? {thinkingMode} : {}), thinking}
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
  const persistedOptions = {
    ...(options.thinking ? {thinking: options.thinking} : {}),
    ...(options.thinkingMode ? {thinkingMode: options.thinkingMode} : {}),
  }

  return Object.keys(persistedOptions).length > 0 ? persistedOptions : null
}
