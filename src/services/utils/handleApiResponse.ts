// TODO:  handleApiResponse is an not needed abstraction that should be removed,
// every service or api call should handle there own errors etc.
export const handleApiResponse = <T>(
  response: {data?: T | null; error?: unknown; status?: number},
  errorMessage = 'An error occurred',
): NonNullable<T> => {
  // Check for Eden/Treaty level errors (network, parsing, etc.)
  if (response.error) {
    if (typeof response.error === 'object' && response.error !== null && 'message' in response.error) {
      throw new Error((response.error as {message: string}).message || errorMessage)
    }
    throw new Error(errorMessage)
  }

  // Check for application-level errors in the data
  if (response.data && typeof response.data === 'object' && response.data !== null) {
    if ('error' in response.data && response.data.error) {
      const error = response.data.error
      const errorMsg =
        typeof error === 'string'
          ? error
          : typeof error === 'object' && error !== null && 'message' in error
            ? String((error as {message: unknown}).message)
            : JSON.stringify(error)
      throw new Error(errorMsg)
    }

    // Also check for nested data.error pattern
    if ('data' in response.data && response.data.data === null && 'error' in response.data && response.data.error) {
      const error = response.data.error
      const errorMsg =
        typeof error === 'string'
          ? error
          : typeof error === 'object' && error !== null && 'message' in error
            ? String((error as {message: unknown}).message)
            : JSON.stringify(error)
      throw new Error(errorMsg)
    }
  }

  // Check if data exists
  if (response.data === undefined || response.data === null) {
    throw new Error('No data returned')
  }

  return response.data as NonNullable<T>
}
