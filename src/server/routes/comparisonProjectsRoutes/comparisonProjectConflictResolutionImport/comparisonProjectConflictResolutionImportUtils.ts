export const getTrimmedText = (value: string | null | undefined) => {
  const trimmedValue = value?.trim() ?? ''
  return trimmedValue.length > 0 ? trimmedValue : null
}

export const getNormalizedResolutionValue = (value: string) => {
  return value.trim()
}

export const getUniqueStringValues = (values: readonly string[]) => {
  return values.reduce<string[]>((uniqueValues, value) => {
    return uniqueValues.includes(value) ? uniqueValues : [...uniqueValues, value]
  }, [])
}
