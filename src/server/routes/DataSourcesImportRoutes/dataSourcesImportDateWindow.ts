const fallbackFromDate = '2020-01-01'

export const formatUtcDay = (date: Date) => {
  return date.toISOString().slice(0, 10)
}

export const getDataSourceImportDateWindow = (
  record: {dateFrom: Date | null; dateTo: Date | null},
  now = new Date(),
): {fromDate: string; toDate: string} => {
  const recordToDate = record.dateTo ?? now

  return {
    fromDate: record.dateFrom ? formatUtcDay(record.dateFrom) : fallbackFromDate,
    toDate: formatUtcDay(recordToDate > now ? now : recordToDate),
  }
}
