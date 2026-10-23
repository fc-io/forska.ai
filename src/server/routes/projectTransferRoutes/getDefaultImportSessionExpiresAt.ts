export const getDefaultImportSessionExpiresAt = (now: Date) => {
  return new Date(now.getTime() + 24 * 60 * 60 * 1000)
}
