export const getLatestClosedUtcDay = (now = new Date()) => {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

const millisecondsPerDay = 24 * 60 * 60 * 1000

export const getUtcDayStart = (date: Date) => {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

export const addUtcDays = (date: Date, days: number) => {
  return new Date(getUtcDayStart(date).getTime() + days * millisecondsPerDay)
}

export const minDate = (left: Date, right: Date) => {
  return left.getTime() <= right.getTime() ? left : right
}
