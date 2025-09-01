export const formatNumber = (num: number | null | undefined): string => {
  if (num == null) return '0'
  // Use the browser's default locale(s)
  return num.toLocaleString()
}