export const getUniqueSortedStrings = (values: string[]) => {
  return Array.from(
    new Set(
      values.filter((value) => {
        return typeof value === 'string' && value.trim() !== ''
      }),
    ),
  ).sort((a, b) => {
    return a.localeCompare(b)
  })
}
