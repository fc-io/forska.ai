export const getPromptMetadataValue = (value: string | null | undefined) => {
  return value === undefined ? undefined : value === null || value.trim().length === 0 ? null : value
}
