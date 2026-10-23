import {getDateValue} from '../../services/appQueryHelpers.ts'

export const getIsoDateString = (value: unknown): string | null => {
  return getDateValue(value)?.toISOString() ?? null
}
