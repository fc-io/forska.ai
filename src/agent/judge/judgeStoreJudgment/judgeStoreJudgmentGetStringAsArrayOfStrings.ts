// feals a bit to strict to not allow other types, like numbers
const isStringArray = (value: unknown): value is string[] => {
  return (
    Array.isArray(value)
    && value.every((item) => {
      return typeof item === 'string'
    })
  )
}

const parseStringArray = (text: string): string[] | null => {
  try {
    const value: unknown = JSON.parse(text)

    return isStringArray(value) ? value : null
  } catch {
    return null
  }
}

export const judgeStoreJudgmentGetStringAsArrayOfStrings = (answeredOriginal: string): string[] | null => {
  return parseStringArray(answeredOriginal)
}
