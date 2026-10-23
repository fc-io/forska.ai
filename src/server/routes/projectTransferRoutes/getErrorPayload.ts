export const getErrorPayload = (error: unknown) => {
  return error instanceof Error ? {message: error.message, name: error.name} : {message: String(error)}
}
