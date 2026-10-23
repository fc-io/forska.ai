export const getDuckdbOwnerProxyErrorMessage = (error: unknown) => {
  return error instanceof Error ? error.message : String(error)
}
