export const getRouterHistoryMode = (protocol: string | null | undefined): 'browser' | 'hash' => {
  const normalizedProtocol = String(protocol ?? '')
    .trim()
    .toLowerCase()

  return normalizedProtocol === 'views:' || normalizedProtocol === 'file:' ? 'hash' : 'browser'
}
