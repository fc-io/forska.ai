// feals a bit to strict to not allow other types, like numbers
const isStringArray = (value: unknown): value is string[] => {
  return (
    Array.isArray(value)
    && value.every((item) => {
      return typeof item === 'string'
    })
  )
}

const parseStringArray = (text: unknown): string[] | null => {
  try {
    return isStringArray(text) ? text : null
  } catch {
    return null
  }
}

export const judgeStoreJudgmentGetStringAsArrayOfStrings = (answeredOriginal: unknown): string[] | null => {
  return parseStringArray(answeredOriginal)
}
