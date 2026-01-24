type DateParts = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  millisecond: number
}

const getDateParts = (value: string): DateParts | null => {
  const trimmed = value.trim()
  const withoutZ = trimmed.endsWith('Z') ? trimmed.slice(0, -1) : trimmed
  const normalized = withoutZ.includes('T') ? withoutZ : withoutZ.replace(' ', 'T')
  const [datePart, timePartRaw] = normalized.split('T')

  if (!datePart || !timePartRaw) return null

  const [yearStr, monthStr, dayStr] = datePart.split('-')
  const [timePart, fractionPart] = timePartRaw.split('.')
  const [hourStr, minuteStr, secondStr] = timePart.split(':')

  const year = Number(yearStr)
  const month = Number(monthStr)
  const day = Number(dayStr)
  const hour = Number(hourStr)
  const minute = Number(minuteStr)
  const second = Number(secondStr)
  const millisecond = fractionPart ? Number(fractionPart.padEnd(3, '0').slice(0, 3)) : 0

  const numbers = [year, month, day, hour, minute, second, millisecond]
  const isValid = numbers.every((n) => {
    return Number.isFinite(n)
  })

  return isValid ? {year, month, day, hour, minute, second, millisecond} : null
}

export const parseClickhouseDateTimeUtc = (value: string | null | undefined): Date | null => {
  const parts = value ? getDateParts(value) : null

  return parts
    ? new Date(
        Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond),
      )
    : null
}
