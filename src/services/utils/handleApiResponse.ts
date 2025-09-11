export const handleApiResponse = <T>(
  response: {data?: T; error?: unknown; status?: number},
  errorMessage = 'An error occurred',
): T => {
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
      throw new Error(String(response.data.error))
    }

    // Also check for nested data.error pattern
    if ('data' in response.data && response.data.data === null && 'error' in response.data && response.data.error) {
      throw new Error(String(response.data.error))
    }
  }

  // Check if data exists
  if (response.data === undefined || response.data === null) {
    throw new Error('No data returned')
  }

  return response.data
}
