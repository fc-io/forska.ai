export const shouldDisableServerMutationWork = (envValues: Record<string, string | undefined> = process.env) => {
  return envValues.FORSKA_DISABLE_SERVER_MUTATIONS === 'true'
}
