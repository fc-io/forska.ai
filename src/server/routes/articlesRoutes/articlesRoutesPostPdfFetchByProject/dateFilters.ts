import {getDateValue} from '../../../services/appQueryHelpers.ts'

const getDateFilterValue = (value: Date | string | undefined | null) => {
  const date = getDateValue(value)

  return date ? date.toISOString() : undefined
}

const isDateOnlyFilterValue = (value: unknown) => {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

const getBoundedDateFilterValue = (value: Date | string | undefined | null): string | undefined => {
  return isDateOnlyFilterValue(value) ? String(value) : getDateFilterValue(value)
}

export const getLaterDateFilter = (left: Date | string | undefined | null, right: Date | string | undefined | null) => {
  const leftDate = getDateValue(left)
  const rightDate = getDateValue(right)
  const value = !leftDate || (rightDate && rightDate > leftDate) ? right : left

  return getBoundedDateFilterValue(value)
}

export const getEarlierDateFilter = (
  left: Date | string | undefined | null,
  right: Date | string | undefined | null,
) => {
  const leftDate = getDateValue(left)
  const rightDate = getDateValue(right)
  const value = !leftDate || (rightDate && rightDate < leftDate) ? right : left

  return getBoundedDateFilterValue(value)
}
