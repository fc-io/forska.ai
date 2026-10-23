export const getComparisonProjectPdfExportedAtLabel = (date = new Date()) => {
  const pad = (value: number) => {
    return String(value).padStart(2, '0')
  }

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`
}
