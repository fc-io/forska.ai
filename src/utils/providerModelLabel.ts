import {type ProviderModelThinkingOption} from './providerModelOptions.ts'

const thinkingSuffixPattern = /\s+\(thinking:\s*[^)]+\)$/i

export const getProviderModelThinkingBadgeLabel = (
  thinking: ProviderModelThinkingOption | null | undefined,
): string | null => {
  return thinking ? `thinking: ${thinking}` : null
}

export const stripProviderModelThinkingBadgeLabel = (label: string): string => {
  return label.replace(thinkingSuffixPattern, '').trim()
}

export const appendProviderModelThinkingBadgeLabel = ({
  label,
  thinking,
}: {
  label: string
  thinking: ProviderModelThinkingOption | null | undefined
}): string => {
  const normalizedLabel = stripProviderModelThinkingBadgeLabel(label)
  const thinkingLabel = getProviderModelThinkingBadgeLabel(thinking)

  return thinkingLabel ? `${normalizedLabel} (${thinkingLabel})` : normalizedLabel
}
