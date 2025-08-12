export const getShortId = (): string => {
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  return Buffer.from(bytes).toString('base64url') // 8 chars
}
