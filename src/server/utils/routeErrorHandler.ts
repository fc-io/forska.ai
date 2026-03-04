import {Elysia} from 'elysia'

import {isHttpError} from './httpError.ts'

const getCause = (value: unknown) => {
  if (typeof value !== 'object' || value === null || !('cause' in value)) {
    return undefined
  }
  return (value as {cause?: unknown}).cause
}

const getErrorMessage = (value: unknown) => {
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'object' && value !== null && 'message' in value) {
    const message = (value as {message?: unknown}).message
    return typeof message === 'string' ? message : undefined
  }
  return undefined
}

export const withErrorHandler = () => {
  return new Elysia().onError(({code, error, set}) => {
    const cause = getCause(error)
    const message = error instanceof Error ? error.message : (getErrorMessage(error) ?? 'Unknown error')
    const causeMessage = getErrorMessage(cause)
    if (cause) {
      console.error(`Route error [${code}]`, {message, cause})
    } else {
      console.error(`Route error [${code}]:`, error)
    }

    if (isHttpError(error)) {
      set.status = error.status
      return {data: null, error: message}
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
      const combined = causeMessage ? `${error.message} — ${causeMessage}` : error.message
      // Default error response
      set.status = 500
      return {data: null, error: combined || 'An unexpected error occurred'}
    }

    // Fallback for unknown errors
    set.status = 500
    return {data: null, error: 'An unexpected error occurred'}
  })
}
