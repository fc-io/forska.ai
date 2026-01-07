/**
 * Utility functions for processing fulltext content before sending to LLM.
 *
 * - stripMarkdownImages: Removes base64-embedded images from markdown
 * - checkFulltextTokenBudget: Validates fulltext fits within model context window
 */

/**
 * Regex to match markdown images with base64 data URIs.
 * Matches: ![alt text](data:image/...;base64,...)
 */
const MARKDOWN_IMAGE_REGEX = /!\[([^\]]*)\]\(data:image\/[^;]+;base64,[^)]+\)/g

/**
 * Regex to match markdown images (general pattern - any URL or data URI).
 * Use this if you want to remove all images, not just base64 ones.
 */
export const MARKDOWN_IMAGE_GENERAL_REGEX = /!\[([^\]]*)\]\([^)]+\)/g

/**
 * Remove base64-embedded images from markdown text.
 * These images take up a lot of tokens but provide no useful text content.
 *
 * Example input: `![Image](data:image/png;base64,iVBORw0KGgoAAAANSUetc==)`
 * Output: `` (empty string or placeholder)
 *
 * @param markdown - The markdown text containing potential base64 images
 * @param replacementText - Optional text to replace removed images (default: empty)
 * @returns Cleaned markdown with images removed
 */
export const stripMarkdownImages = (markdown: string, replacementText = ''): string => {
  // Replace base64 images with the replacement text
  const result = markdown.replace(MARKDOWN_IMAGE_REGEX, replacementText)

  // Log if any images were removed
  const originalLength = markdown.length
  const newLength = result.length
  const bytesRemoved = originalLength - newLength

  if (bytesRemoved > 0) {
    const approxTokensSaved = Math.ceil(bytesRemoved / 4)
    console.log(
      `[stripMarkdownImages] Removed base64 images: ${bytesRemoved.toLocaleString()} chars (~${approxTokensSaved.toLocaleString()} tokens saved)`,
    )
  }

  return result
}

/**
 * Token budget configuration.
 * We use a conservative estimate of 4 characters per token for English text.
 */
const CHARS_PER_TOKEN = 4

/**
 * Reserved tokens for various parts of the prompt.
 * These values leave room for the title, summary, question, and response.
 */
const RESERVED_FOR_PROMPT = 2000 // title, summary, question, system prompt
const RESERVED_FOR_RESPONSE = 2000 // max_completion_tokens is 2000 in judge.ts

/**
 * Default model context window (conservative estimate).
 * Most modern models have 32K+ context, but we use a safe default.
 */
const DEFAULT_MODEL_CONTEXT = 32768

export type TokenBudgetResult =
  | {withinBudget: true; tokenCount: number}
  | {withinBudget: false; tokenCount: number; maxTokens: number}

/**
 * Check if fulltext fits within the token budget.
 *
 * @param fullText - The fulltext content to check
 * @param modelContext - The model's context window size (default: 32768)
 * @returns Result indicating whether content fits and token counts
 */
export const checkFulltextTokenBudget = (
  fullText: string,
  modelContext: number = DEFAULT_MODEL_CONTEXT,
): TokenBudgetResult => {
  const maxFulltextTokens = modelContext - RESERVED_FOR_PROMPT - RESERVED_FOR_RESPONSE

  // Estimate token count (conservative: 4 chars per token)
  const estimatedTokens = Math.ceil(fullText.length / CHARS_PER_TOKEN)

  if (estimatedTokens <= maxFulltextTokens) {
    return {withinBudget: true, tokenCount: estimatedTokens}
  }

  return {
    withinBudget: false,
    tokenCount: estimatedTokens,
    maxTokens: maxFulltextTokens,
  }
}

/**
 * Process fulltext for LLM consumption:
 * 1. Optionally strip images
 * 2. Check token budget
 *
 * @param fullText - The raw fulltext content
 * @param options - Processing options
 * @returns Processed result with status
 */
export type ProcessFulltextOptions = {
  stripImages: boolean
  modelContext?: number
}

export type ProcessFulltextResult =
  | {success: true; processedText: string; tokenCount: number}
  | {success: false; reason: 'fulltext_too_large'; tokenCount: number; maxTokens: number}

export const processFulltextForLLM = (
  fullText: string,
  options: ProcessFulltextOptions,
): ProcessFulltextResult => {
  // Step 1: Optionally strip images
  const processedText = options.stripImages ? stripMarkdownImages(fullText) : fullText

  // Step 2: Check token budget
  const budgetResult = checkFulltextTokenBudget(processedText, options.modelContext)

  if (budgetResult.withinBudget) {
    return {
      success: true,
      processedText,
      tokenCount: budgetResult.tokenCount,
    }
  }

  return {
    success: false,
    reason: 'fulltext_too_large',
    tokenCount: budgetResult.tokenCount,
    maxTokens: budgetResult.maxTokens,
  }
}
