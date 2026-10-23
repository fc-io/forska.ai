import {getQuotedStringList} from '../../../services/appQueryHelpers.ts'

export const isDefined = <T>(value: T | null | undefined): value is T => {
  return value !== null && value !== undefined
}

export const getPositiveInteger = (value: number) => {
  const integerValue = Number.isFinite(value) ? Math.floor(value) : 1
  return Math.max(integerValue, 1)
}

export const getInClause = (values: string[]) => {
  return getQuotedStringList(values).join(', ')
}
