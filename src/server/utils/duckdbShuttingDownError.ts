const duckdbShuttingDownErrorName = 'DuckdbShuttingDownError'
const duckdbShuttingDownErrorMessagePrefix = 'DuckDB is shutting down'

export const createDuckdbShuttingDownError = (operation: string) => {
  const error = new Error(`${duckdbShuttingDownErrorMessagePrefix}; rejecting ${operation}`)
  error.name = duckdbShuttingDownErrorName

  return error
}

export const isDuckdbShuttingDownError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)

  return (
    (error instanceof Error && error.name === duckdbShuttingDownErrorName)
    || message.includes(duckdbShuttingDownErrorMessagePrefix)
  )
}
