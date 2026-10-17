const legacyMarkdownBase64ImageRegex = /!\[([^\]]*)\]\(data:image\/[^;]+;base64,[^)]+\)/g
const legacyCharsPerToken = 4
const legacyReservedPromptTokens = 2000

export type ProjectTransferLegacyFullTextSignature = {
  maxTokens: number
  processedText: string
  tokenCount: number
  withinBudget: boolean
}

export const getProjectTransferLegacyFullTextSignature = (
  fullText: string,
  options: {promptTokenLimit: number; stripImages: boolean},
): ProjectTransferLegacyFullTextSignature => {
  const processedText = options.stripImages ? fullText.replace(legacyMarkdownBase64ImageRegex, '') : fullText
  const maxTokens = options.promptTokenLimit - legacyReservedPromptTokens
  const tokenCount = Math.ceil(processedText.length / legacyCharsPerToken)

  return {maxTokens, processedText, tokenCount, withinBudget: tokenCount <= maxTokens}
}
