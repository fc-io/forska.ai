const thinkingSuffixPattern = /\s+\(thinking:\s*[^)]+\)$/i

const getTrimmedValue = (value: string | null | undefined) => {
  const normalized = String(value ?? '').trim()

  return normalized === '' ? null : normalized
}

const getNormalizedProvider = (value: string | null | undefined) => {
  return String(value ?? '')
    .trim()
    .toLowerCase()
}

export const getProviderModelThinkingBadgeValue = ({
  provider,
  thinking,
  version,
}: {
  provider: string | null | undefined
  thinking: string | null | undefined
  version: string | null | undefined
}) => {
  const normalizedThinking = getTrimmedValue(thinking)
  const normalizedProvider = getNormalizedProvider(provider)
  const normalizedVersion = getTrimmedValue(version)

  return (
    normalizedThinking
    ?? (normalizedProvider === 'anthropic' || normalizedProvider === 'codex' ? normalizedVersion : null)
  )
}

export const getProviderModelThinkingBadgeLabel = (thinking: string | null | undefined): string | null => {
  const normalizedThinking = getTrimmedValue(thinking)

  return normalizedThinking ? `thinking: ${normalizedThinking}` : null
}

export const stripProviderModelThinkingBadgeLabel = (label: string): string => {
  return label.replace(thinkingSuffixPattern, '').trim()
}

export const appendProviderModelThinkingBadgeLabel = ({
  label,
  thinking,
}: {
  label: string
  thinking: string | null | undefined
}): string => {
  const normalizedLabel = stripProviderModelThinkingBadgeLabel(label)
  const thinkingLabel = getProviderModelThinkingBadgeLabel(thinking)

  return thinkingLabel ? `${normalizedLabel} (${thinkingLabel})` : normalizedLabel
}
