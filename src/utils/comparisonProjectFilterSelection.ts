export type ComparisonProjectFilterSelection<T extends string> = T | readonly T[] | null | undefined

const getRawSelectionValues = (value: unknown): unknown[] => {
  return Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
}

export const getComparisonProjectFilterSelectionValues = (value: unknown): string[] => {
  return Array.from(
    new Set(
      getRawSelectionValues(value)
        .filter((candidate): candidate is string => {
          return typeof candidate === 'string'
        })
        .map((candidate) => {
          return candidate.trim()
        })
        .filter((candidate) => {
          return candidate !== '' && candidate !== 'all'
        }),
    ),
  )
}

export const getComparisonProjectFilterSelectionSearchParam = (values: readonly string[]) => {
  return values.join(',')
}

export const getIsSameComparisonProjectFilterSelection = (left: readonly string[], right: readonly string[]) => {
  return (
    left.length === right.length
    && left.every((value, index) => {
      return value === right[index]
    })
  )
}

export const getStableComparisonProjectFilterSelection = <T extends string>(previous: T[], next: T[]): T[] => {
  return getIsSameComparisonProjectFilterSelection(previous, next) ? previous : next
}

export const getComparisonProjectCanonicalFilterSelection = <T extends string>(
  value: unknown,
  canonicalValues: readonly T[],
): T[] => {
  const selectedValues = new Set(getComparisonProjectFilterSelectionValues(value))

  return canonicalValues.filter((candidate) => {
    return candidate !== 'all' && selectedValues.has(candidate)
  })
}
