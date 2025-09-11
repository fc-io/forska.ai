import {Elysia} from 'elysia'

export const withErrorHandler = () => {
  return new Elysia().onError(({code, error, set}) => {
    console.error(`Route error [${code}]:`, error)

    if (code === 'NOT_FOUND') {
      set.status = 404
      return {data: null, error: 'Resource not found'}
    }

    if (code === 'VALIDATION') {
      set.status = 400
      return {data: null, error: 'Invalid request data'}
    }

    if (code === 'PARSE') {
      set.status = 400
      return {data: null, error: 'Failed to parse request'}
    }

    // Handle database errors
    if (error instanceof Error) {
      if (error.message.includes('not found')) {
        set.status = 404
        return {data: null, error: error.message}
      }

      // Default error response
      set.status = 500
      return {data: null, error: error.message || 'An unexpected error occurred'}
    }

    // Fallback for unknown errors
    set.status = 500
    return {data: null, error: 'An unexpected error occurred'}
  })
}
