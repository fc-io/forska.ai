export const comparisonProjectSearchTextMaxLength = 200

const whitespacePattern = /\s+/gu

export const getNormalizedComparisonProjectSearchText = (value: unknown): string => {
  const text = typeof value === 'string' ? value : Array.isArray(value) ? String(value[0] ?? '') : ''

  return Array.from(text.replace(whitespacePattern, ' ').trim()).slice(0, comparisonProjectSearchTextMaxLength).join('')
}
