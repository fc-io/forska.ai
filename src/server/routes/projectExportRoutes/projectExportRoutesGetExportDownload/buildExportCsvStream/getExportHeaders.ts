import type {PromptDetails} from '../../projectExportRouteTypes.ts'
import type {ExportContract} from '../projectExportDownloadTypes.ts'

const buildPromptMetadataLines = (
  promptType: string,
  promptContent: string,
  includePromptType: boolean,
  includePromptContent: boolean,
) => {
  return [
    includePromptType ? `Type: ${promptType}` : '',
    includePromptContent ? `Content: ${promptContent}` : '',
  ].filter(Boolean)
}

const buildPromptHeaderLabel = (
  heading: string,
  promptType: string,
  promptContent: string,
  includePromptType: boolean,
  includePromptContent: boolean,
) => {
  const metadataLines = buildPromptMetadataLines(promptType, promptContent, includePromptType, includePromptContent)

  return (metadataLines.length > 0 ? [heading, ...metadataLines] : [heading]).join('\n')
}

export const getExportHeaders = (input: {
  contract: ExportContract
  includeFullTextStrategy: boolean
  orderedPromptDetails: PromptDetails[]
  selectedMetadata: Record<string, boolean | undefined>
}) => {
  const promptOutput = input.contract.promptOutput ?? {}
  const headers = ['Title']

  if (input.selectedMetadata.includeArticleId) headers.push('Article ID')
  if (input.selectedMetadata.includeArticleLink) headers.push('Article Link')
  if (input.selectedMetadata.includeArticleAuthors) headers.push('Article Authors')
  if (input.selectedMetadata.includeSummary) headers.push('Abstract/Summary')
  if (input.selectedMetadata.includeJournal) headers.push('Journal')
  if (input.selectedMetadata.includeArticleCreatedAt) headers.push('Article Created At')
  if (input.selectedMetadata.includeArticleUpdatedAt) headers.push('Article Updated At')
  if (input.includeFullTextStrategy) headers.push('Full-text strategy')

  input.orderedPromptDetails.forEach((prompt) => {
    const baseHeading = prompt.promptHeading || (prompt.originalText ?? '').substring(0, 50) || prompt.id
    const heading = buildPromptHeaderLabel(
      baseHeading,
      prompt.type ?? '',
      prompt.originalText ?? '',
      promptOutput.includePromptType ?? false,
      promptOutput.includePromptContent ?? false,
    )
    headers.push(heading)
    if (promptOutput.includeExplanation) headers.push(`${baseHeading} - Explanation`)
    if (promptOutput.includeQuotes) headers.push(`${baseHeading} - Quotes`)
  })

  return headers
}
