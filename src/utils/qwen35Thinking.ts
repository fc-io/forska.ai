export const qwen35ThinkingVariants = ['non-thinking', 'thinking'] as const

export type Qwen35ThinkingVariant = (typeof qwen35ThinkingVariants)[number]

const qwen35ModelPattern = /(?:^|\/)qwen3\.5-/i

export const isQwen35Model = (modelName: string): boolean => {
  return qwen35ModelPattern.test(modelName.trim())
}

export const getQwen35ThinkingVariant = (value: string | null | undefined): Qwen35ThinkingVariant | null => {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()

  return normalized === 'thinking' || normalized === 'non-thinking' ? normalized : null
}

export const getQwen35ThinkingEnabled = (value: string | null | undefined): boolean => {
  return getQwen35ThinkingVariant(value) === 'thinking'
}
