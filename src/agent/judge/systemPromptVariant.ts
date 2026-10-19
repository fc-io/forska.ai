export const systemPromptVariants = ['legacy', 'screening_v1', 'screening_v2', 'screening_v3'] as const

export type SystemPromptVariant = (typeof systemPromptVariants)[number]

export const defaultSystemPromptVariant: SystemPromptVariant = 'legacy'

export const newProjectSystemPromptVariant: SystemPromptVariant = 'screening_v3'

const articleMetadataQuoteSystemPromptVariants: readonly SystemPromptVariant[] = ['screening_v2', 'screening_v3']

export const isSystemPromptVariant = (value: unknown): value is SystemPromptVariant => {
  return typeof value === 'string' && (systemPromptVariants as readonly string[]).includes(value)
}

export const getSystemPromptVariant = (value: unknown): SystemPromptVariant => {
  return isSystemPromptVariant(value) ? value : defaultSystemPromptVariant
}

export const systemPromptVariantAllowsArticleMetadataQuotes = (value: unknown): boolean => {
  return articleMetadataQuoteSystemPromptVariants.includes(getSystemPromptVariant(value))
}
