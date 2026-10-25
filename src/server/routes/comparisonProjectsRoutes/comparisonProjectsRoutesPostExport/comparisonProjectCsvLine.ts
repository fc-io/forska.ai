export const escapeComparisonProjectCsvValue = (value: string) => {
  return value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')
    ? `"${value.replace(/"/g, '""')}"`
    : value
}

export const getComparisonProjectCsvLine = (values: string[]) => {
  return `${values.map(escapeComparisonProjectCsvValue).join(',')}\n`
}
