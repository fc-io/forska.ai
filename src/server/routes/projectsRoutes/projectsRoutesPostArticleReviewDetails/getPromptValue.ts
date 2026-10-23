export const getPromptValue = (row: {promptOriginalText: string; promptHeading: string | null}) => {
  return {originalText: row.promptOriginalText, promptHeading: row.promptHeading}
}
