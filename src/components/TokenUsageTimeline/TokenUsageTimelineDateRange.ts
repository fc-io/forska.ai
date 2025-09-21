import {type DateValue, fromDate} from '@internationalized/date'

export type TokenUsageTimelineDateRange = {start: Date; end: Date}

type NormalizeDayParams = {date: Date; hours: number; minutes: number; seconds: number; milliseconds: number}

const normalizeDay = (params: NormalizeDayParams) => {
  const normalized = new Date(params.date)
  normalized.setHours(params.hours, params.minutes, params.seconds, params.milliseconds)
  return normalized
}

export const getTokenUsageTimelineStartOfDay = (date: Date) => {
  return normalizeDay({date, hours: 0, minutes: 0, seconds: 0, milliseconds: 0})
}

export const getTokenUsageTimelineEndOfDay = (date: Date) => {
  return normalizeDay({date, hours: 23, minutes: 59, seconds: 59, milliseconds: 999})
}

export const getTokenUsageTimelinePickerValues = (params: {range: TokenUsageTimelineDateRange; timeZone: string}) => {
  return [
    fromDate(getTokenUsageTimelineStartOfDay(params.range.start), params.timeZone),
    fromDate(getTokenUsageTimelineStartOfDay(params.range.end), params.timeZone),
  ]
}

export const getTokenUsageTimelineDateRange = (params: {values: DateValue[]; timeZone: string}) => {
  if (params.values.length !== 2) {
    return null
  }
  const [startValue, endValue] = params.values
  const startDate = startValue.toDate(params.timeZone)
  const endDate = endValue.toDate(params.timeZone)
  return {start: getTokenUsageTimelineStartOfDay(startDate), end: getTokenUsageTimelineEndOfDay(endDate)}
}
