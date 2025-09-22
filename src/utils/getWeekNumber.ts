import type {DateValue} from '@internationalized/date'

const getIsoWeekNumber = (dateValue: DateValue, timeZone: string) => {
  const jsDate = dateValue.toDate(timeZone)
  const target = new Date(Date.UTC(jsDate.getFullYear(), jsDate.getMonth(), jsDate.getDate()))
  const weekDay = target.getUTCDay() === 0 ? 7 : target.getUTCDay()
  target.setUTCDate(target.getUTCDate() + 4 - weekDay)
  const startOfYear = new Date(Date.UTC(target.getUTCFullYear(), 0, 1))
  const dayCount = Math.floor((target.getTime() - startOfYear.getTime()) / 86400000) + 1
  return Math.ceil(dayCount / 7)
}

export const getWeekNumberLabel = (days: DateValue[], timeZone: string) => {
  const reference = days[3] ?? days[0]
  return reference ? getIsoWeekNumber(reference, timeZone).toString() : ''
}

export {getIsoWeekNumber}
