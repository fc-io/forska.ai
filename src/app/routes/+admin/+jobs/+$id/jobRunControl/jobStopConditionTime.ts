import {addDays, addHours, formatDate, set} from 'date-fns'

export type StopAtQuickPick = {getStopAt: (now: Date) => Date; label: string}

export const stopAtQuickPicks: StopAtQuickPick[] = [
  {
    getStopAt: (now) => {
      return addHours(now, 1)
    },
    label: '+1 h',
  },
  {
    getStopAt: (now) => {
      return addHours(now, 4)
    },
    label: '+4 h',
  },
  {
    getStopAt: (now) => {
      return addHours(now, 8)
    },
    label: '+8 h',
  },
  {
    getStopAt: (now) => {
      return set(addDays(now, 1), {hours: 7, milliseconds: 0, minutes: 0, seconds: 0})
    },
    label: 'Tomorrow 07:00',
  },
]

export const getDateTimeLocalInputValue = (value: Date | null): string => {
  return value === null ? '' : formatDate(value, "yyyy-MM-dd'T'HH:mm")
}

export const getDateFromDateTimeLocalInput = (value: string): Date | null => {
  const date = value.trim() === '' ? null : new Date(value)

  return date && Number.isFinite(date.getTime()) ? date : null
}
