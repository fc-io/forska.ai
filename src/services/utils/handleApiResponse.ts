const getErrorWithMessage = (error: unknown): {message: string} | undefined => {
  return typeof error === 'object'
    && error !== null
    && 'message' in error
    && typeof (error as {message?: unknown}).message === 'string'
    ? ({message: (error as {message: string}).message} as const)
    : undefined
}

const getNestedErrorValue = (error: unknown): unknown => {
  return typeof error === 'object' && error !== null && 'value' in error
    ? (error as {value?: unknown}).value
    : typeof error === 'object' && error !== null && 'error' in error
      ? (error as {error?: unknown}).error
      : undefined
}

const getSerializedError = (error: unknown): string | undefined => {
  return typeof error === 'object' && error !== null ? JSON.stringify(error) : undefined
}

const getUsefulMessage = (message: string | undefined): string | undefined => {
  const trimmed = message?.trim()

  return trimmed && trimmed !== '[object Object]' ? trimmed : undefined
}

const getApiErrorMessage = (error: unknown, fallback: string): string => {
  const nested = getNestedErrorValue(error)
  const message = getUsefulMessage(getErrorWithMessage(error)?.message)
  const serialized = getSerializedError(error)

  return typeof error === 'string'
    ? error
    : typeof error === 'number' || typeof error === 'boolean'
      ? String(error)
      : message
        ? message
        : nested !== undefined
          ? getApiErrorMessage(nested, fallback)
          : serialized && serialized !== '{}'
            ? serialized
            : fallback
}

export const handleApiResponse = <T>(
  response: {data?: T | null; error?: unknown; status?: number},
  errorMessage = 'An error occurred',
): NonNullable<T> => {
  if (response.error) {
    throw new Error(getApiErrorMessage(response.error, errorMessage))
  }

  if (response.data && typeof response.data === 'object' && response.data !== null) {
    if ('data' in response.data && 'error' in response.data && response.data.error) {
      throw new Error(getApiErrorMessage(response.data.error, errorMessage))
    }

    if (response.status && response.status >= 400 && 'error' in response.data && response.data.error) {
      throw new Error(getApiErrorMessage(response.data.error, errorMessage))
    }
  }

  if (response.data === undefined || response.data === null) {
    throw new Error('No data returned')
  }

  return response.data as NonNullable<T>
}
