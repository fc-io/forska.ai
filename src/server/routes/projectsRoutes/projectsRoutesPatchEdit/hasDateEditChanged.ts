import {getDateValue} from '../../../services/appQueryHelpers.ts'

const getDateTime = (value: Date | null) => {
  return value === null ? null : value.getTime()
}

export const hasDateEditChanged = (value: Date | null | undefined, currentValue: unknown) => {
  return value !== undefined && getDateTime(value) !== getDateTime(getDateValue(currentValue))
}
