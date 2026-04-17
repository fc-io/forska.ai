const anthropicAdaptiveThinkingEfforts = ['low', 'medium', 'high', 'max'] as const
const anthropicOpus47ThinkingEfforts = ['low', 'medium', 'high', 'max', 'xhigh'] as const

export type AnthropicThinkingEffort = (typeof anthropicOpus47ThinkingEfforts)[number]

const getNormalizedModelName = (value: string | null | undefined) => {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()

  return normalized === '' ? null : normalized
}

export const getAnthropicThinkingEffort = (value: unknown): AnthropicThinkingEffort | null => {
  const normalized = getNormalizedModelName(typeof value === 'string' ? value : null)

  return normalized && anthropicOpus47ThinkingEfforts.includes(normalized as AnthropicThinkingEffort)
    ? (normalized as AnthropicThinkingEffort)
    : null
}

export const getAnthropicSupportedThinkingEfforts = (
  modelName: string | null | undefined,
): AnthropicThinkingEffort[] => {
  const normalizedModelName = getNormalizedModelName(modelName)

  return normalizedModelName?.startsWith('claude-opus-4-7')
    ? [...anthropicOpus47ThinkingEfforts]
    : normalizedModelName?.startsWith('claude-opus-4-6') || normalizedModelName?.startsWith('claude-sonnet-4-6')
      ? [...anthropicAdaptiveThinkingEfforts]
      : []
}

export const getAnthropicThinkingConfig = ({
  modelName,
  version,
}: {
  modelName: string
  version: string | null
}): {outputConfig: {effort: AnthropicThinkingEffort}; thinking: {display: 'omitted'; type: 'adaptive'}} | null => {
  const effort = getAnthropicThinkingEffort(version)
  const supportedEfforts = getAnthropicSupportedThinkingEfforts(modelName)

  return effort && supportedEfforts.includes(effort)
    ? {outputConfig: {effort}, thinking: {display: 'omitted', type: 'adaptive'}}
    : null
}
