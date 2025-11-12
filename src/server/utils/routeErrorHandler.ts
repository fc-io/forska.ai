import {Elysia} from 'elysia'

export const withErrorHandler = () => {
  return new Elysia().onError(({code, error, set}) => {
    const cause = (error as any)?.cause
    if (cause) {
      console.error(`Route error [${code}]`, {message: (error as Error).message, cause})
    } else {
      console.error(`Route error [${code}]:`, error)
    }

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

    // Handle database and other errors
    if (error instanceof Error) {
      if (error.message.includes('not found')) {
        set.status = 404
        return {data: null, error: error.message}
      }

      // Include underlying DB error details when present (useful for debugging)
      const causeMsg = typeof (error as any)?.cause?.message === 'string' ? (error as any).cause.message : undefined
      const combined = causeMsg ? `${error.message} — ${causeMsg}` : error.message
      // Default error response
      set.status = 500
      return {data: null, error: combined || 'An unexpected error occurred'}
    }

    // Fallback for unknown errors
    set.status = 500
    return {data: null, error: 'An unexpected error occurred'}
  })
}
