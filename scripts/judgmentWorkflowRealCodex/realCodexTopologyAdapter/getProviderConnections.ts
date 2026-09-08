export const getProviderConnections = (body: unknown) => {
  if (typeof body !== 'object' || body === null || !('data' in body)) {
    throw new Error('Provider connections response is missing data')
  }
  const data = body.data
  if (typeof data !== 'object' || data === null || !('connections' in data) || !Array.isArray(data.connections)) {
    throw new Error('Provider connections response data.connections was not an array')
  }

  return data.connections.map((connection: unknown) => {
    if (typeof connection !== 'object' || connection === null || Array.isArray(connection)) {
      throw new Error('Provider connections response contained a non-object connection')
    }
    return connection as Record<string, unknown>
  })
}
