export const getStringArray = (value: unknown) => {
  return Array.isArray(value)
    ? value.filter((item): item is string => {
        return typeof item === 'string'
      })
    : []
}
