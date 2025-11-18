const isStringArray = (value: unknown): value is string[] => {
  return (
    Array.isArray(value)
    && value.every((item) => {
      return typeof item === 'string'
    })
  )
}

const parseStringArray = (text: string): string[] => {
  try {
    const value: unknown = JSON.parse(text)
    return isStringArray(value) ? value : []
  } catch {
    return []
  }
}

export const judgeStoreJudgmentGetStringAsArrayOfStrings = (answeredOriginal: string): string[] => {
  const stringAsArray = parseStringArray(answeredOriginal)

  return stringAsArray
}
