export const systemPromptVariants = ['legacy', 'screening_v1'] as const

export type SystemPromptVariant = (typeof systemPromptVariants)[number]

export const defaultSystemPromptVariant: SystemPromptVariant = 'legacy'

export const covidenceSystemPromptVariant: SystemPromptVariant = 'screening_v1'

export const isSystemPromptVariant = (value: unknown): value is SystemPromptVariant => {
  return typeof value === 'string' && (systemPromptVariants as readonly string[]).includes(value)
}

export const getSystemPromptVariant = (value: unknown): SystemPromptVariant => {
  return isSystemPromptVariant(value) ? value : defaultSystemPromptVariant
}
