export const parseArktypeOptions = (typeStr: string | null): string[] => {
  if (!typeStr) return []
  const matches = typeStr.match(/['"]([^'"]+)['"]/g)
  return (
    matches?.map((match) => {
      return match.slice(1, -1)
    }) ?? []
  )
}

export const isArrayType = (typeStr: string | null): boolean => {
  if (!typeStr) return false
  return typeStr.includes('[]')
}

export const isOpenEndedType = (typeStr: string | null): boolean => {
  if (!typeStr) return true
  return !/['"]/.test(typeStr)
}
