import {getQuotedStringList} from '../../../services/appQueryHelpers.ts'

export const getInClause = (values: string[]) => {
  return getQuotedStringList(values).join(', ')
}

export const getWhereClause = (conditions: Array<string | null | undefined>) => {
  const filteredConditions = conditions.filter((condition): condition is string => {
    return Boolean(condition)
  })
  return filteredConditions.length > 0 ? `WHERE ${filteredConditions.join('\n  AND ')}` : ''
}
