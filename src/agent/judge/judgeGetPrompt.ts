import * as schema from '../../db/schema.ts'

export type PromptForJudging = Array<{
  id: string
  originalText: string
  promptHeading: string | null
  order: number | null
  type: string | null
}>

// Mapping from short ID to full prompt UUID
export type ShortIdMapping = Map<string, string>

// Create a stable 4-char short ID from a UUID
const uuidToShortId = (uuid: string): string => {
  // Use first 4 chars of the UUID (after removing dashes)
  return uuid.replace(/-/g, '').slice(0, 4)
}

/**
 * Creates a mapping from short IDs to prompt UUIDs.
 * Short IDs are used in prompts to reduce LLM transcription errors.
 */
export const createShortIdMapping = (prompts: PromptForJudging): ShortIdMapping => {
  const mapping = new Map<string, string>()
  prompts.forEach((prompt) => {
    const shortId = uuidToShortId(prompt.id)
    mapping.set(shortId, prompt.id)
  })
  return mapping
}

/**
 * Get the short ID for a prompt from the mapping.
 */
export const getShortIdForPrompt = (promptId: string, mapping: ShortIdMapping): string => {
  for (const [shortId, uuid] of mapping.entries()) {
    if (uuid === promptId) return shortId
  }
  // Fallback: generate short ID directly
  return uuidToShortId(promptId)
}

/**
 * Build the base heading for a prompt using its short ID.
 */
export const getBaseHeading = (prompt: PromptForJudging[number], shortId: string): string => {
  return (prompt.promptHeading ?? `${prompt.order ?? 0}`) + `^^^${shortId}`
}

const getSections = (prompts: PromptForJudging, shortIdMapping: ShortIdMapping): string => {
  return prompts.reduce((acc, prompt) => {
    const shortId = getShortIdForPrompt(prompt.id, shortIdMapping)
    const baseHeading = getBaseHeading(prompt, shortId)

    return `${acc}
### ${baseHeading}---question

question: ${prompt.originalText}

output_type: ${prompt.type}
`
  }, '')
}

type ArticleType = typeof schema.articles.$inferSelect

export type JudgePromptResult = {prompt: string; shortIdMapping: ShortIdMapping}

export const judgeGetPrompt = (article: ArticleType, prompts: PromptForJudging): JudgePromptResult => {
  const shortIdMapping = createShortIdMapping(prompts)
  const sections = getSections(prompts, shortIdMapping)

  const prompt = `# id: ${article.articleId}

## article_title

${article.articleTitle}

## article_summary

${article.articleSummary}

## Below will be a number of questions from the user for you to answer about the title and summary provided above:
${sections}`

  return {prompt, shortIdMapping}
}

export type SinglePromptType = {
  id: string
  originalText: string
  promptHeading: string | null
  order: number | null
  type: string | null
}

/**
 * Generate a prompt for a single question about an article.
 * This function is optimized for sending individual prompts to the LLM.
 */
export const judgeGetSinglePrompt = (article: ArticleType, singlePrompt: SinglePromptType): JudgePromptResult => {
  const shortIdMapping = createShortIdMapping([singlePrompt])
  const shortId = getShortIdForPrompt(singlePrompt.id, shortIdMapping)
  const baseHeading = getBaseHeading(singlePrompt, shortId)

  const prompt = `# id: ${article.articleId}

## article_title

${article.articleTitle}

## article_summary

${article.articleSummary}

## Below is a question from the user for you to answer about the title and summary provided above:

### ${baseHeading}---question

question: ${singlePrompt.originalText}

output_type: ${singlePrompt.type}`

  return {prompt, shortIdMapping}
}
