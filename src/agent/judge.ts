import OpenAI from 'openai'
import type {ChatCompletionMessage} from 'openai/resources/chat/completions'

import * as schema from '../db/schema.ts'
import {
  ConnectionError,
  isConnectionError,
  recordConnectionFailure,
  recordConnectionSuccess,
} from '../server/cron/judgmentsJobs/connectionHealth.ts'
import {rateLimitedLogger} from '../server/utils/rateLimitedLogger.ts'
import type {ContentSettings} from './judge/judgeGetPrompt.ts'
import {judgeGetSinglePrompt} from './judge/judgeGetPrompt.ts'
import {SINGLE_PROMPT_SYSTEM_PROMPT} from './judge/judgeSinglePromptSystemPrompt.ts'
import {judgeStoreTokenUse, type JudgeTokenUsageEntry} from './judge/judgeStoreTokenUse.ts'
import {
  type ParseAttemptResult,
  parseSinglePromptJudgment,
  tryParseJsonWithSanitization,
} from './judge/parseSinglePromptJudgment.ts'
import {storeSinglePromptJudgment} from './judge/storeSinglePromptJudgment.ts'

const openAIClients = new Map<string, OpenAI>()

type ModelConfigInput = {modelId: string; modelName: string; baseURL: string}

const loggedFirstJudgeRequestByJobId = new Map<string, true>()

const trimLoggedFirstJudgeRequestByJobId = (): void => {
  return loggedFirstJudgeRequestByJobId.size <= 200
    ? undefined
    : (loggedFirstJudgeRequestByJobId.delete(loggedFirstJudgeRequestByJobId.keys().next().value as string),
      trimLoggedFirstJudgeRequestByJobId())
}

const truncateForLog = (text: string, maxChars: number): {text: string; originalLength: number; truncated: boolean} => {
  const originalLength = text.length
  const truncated = originalLength > maxChars
  const truncatedText = truncated ? `${text.slice(0, maxChars)}…` : text
  return {text: truncatedText, originalLength, truncated}
}

const getFirstRequestPreviewChars = (): number => {
  const fromEnv = Number(process.env.JUDGE_FIRST_REQUEST_PREVIEW_CHARS)
  return Number.isFinite(fromEnv) && fromEnv > 0 ? Math.floor(fromEnv) : 4000
}

const logFirstJudgeRequest = ({
  judgmentsJobId,
  articleId,
  promptId,
  baseURL,
  modelName,
  systemPrompt,
  userPrompt,
  requestConfig,
}: {
  judgmentsJobId: string
  articleId: string
  promptId: string
  baseURL: string
  modelName: string
  systemPrompt: string
  userPrompt: string
  requestConfig: {temperature: number; maxCompletionTokens: number}
}): void => {
  loggedFirstJudgeRequestByJobId.set(judgmentsJobId, true)
  trimLoggedFirstJudgeRequestByJobId()

  const previewChars = getFirstRequestPreviewChars()
  const userPromptPreview = truncateForLog(userPrompt, previewChars)
  const systemPromptPreview = truncateForLog(systemPrompt, previewChars)
  const shouldLogFullPrompt = process.env.JUDGE_FIRST_REQUEST_LOG_FULL === 'true'

  console.log('[judge] first-request', {
    judgmentsJobId,
    articleId,
    promptId,
    baseURL,
    modelName,
    normalizedModelName: normalizeModelName(modelName),
    request: {
      temperature: requestConfig.temperature,
      max_completion_tokens: requestConfig.maxCompletionTokens,
      messages: [
        {
          role: 'system',
          contentLength: systemPromptPreview.originalLength,
          contentTruncated: systemPromptPreview.truncated,
          content: systemPromptPreview.text,
        },
        {
          role: 'user',
          contentLength: userPromptPreview.originalLength,
          contentTruncated: userPromptPreview.truncated,
          content: userPromptPreview.text,
        },
      ],
    },
  })

  return shouldLogFullPrompt
    ? console.log('[judge] first-request:full-user-prompt', {judgmentsJobId, userPrompt})
    : undefined
}

const logFirstJudgeRequestIfNeeded = ({
  judgmentsJobId,
  articleId,
  promptId,
  baseURL,
  modelName,
  systemPrompt,
  userPrompt,
  requestConfig,
}: {
  judgmentsJobId: string
  articleId: string
  promptId: string
  baseURL: string
  modelName: string
  systemPrompt: string
  userPrompt: string
  requestConfig: {temperature: number; maxCompletionTokens: number}
}): void => {
  const alreadyLogged = loggedFirstJudgeRequestByJobId.has(judgmentsJobId)
  return alreadyLogged
    ? undefined
    : logFirstJudgeRequest({
        judgmentsJobId,
        articleId,
        promptId,
        baseURL,
        modelName,
        systemPrompt,
        userPrompt,
        requestConfig,
      })
}

type AssistantMessageShape = {
  role: 'assistant'
  content: string
  tool_calls?: ChatCompletionMessage['tool_calls']
  reasoning_content?: string
}

const getOpenAIClient = (baseURL: string): OpenAI => {
  const existingClient = openAIClients.get(baseURL)
  if (existingClient) {
    return existingClient
  }
  const client = new OpenAI({
    apiKey: 'fake_key',
    dangerouslyAllowBrowser: true,
    baseURL,
    timeout: 900_000, // 15 minutes
    maxRetries: 0, // Handle retries at application level
  })
  openAIClients.set(baseURL, client)
  return client
}

/**
 * Normalize model name for the OpenAI API request.
 * - HuggingFace IDs (e.g., "XiaomiMiMo/MiMo-V2-Flash") pass through unchanged
 * - Legacy local paths (e.g., "./models/...") are normalized to absolute paths
 */
const normalizeModelName = (name: string): string => {
  if (name.startsWith('./models/')) {
    return `/${name.slice(2)}`
  }
  if (name.startsWith('models/')) {
    return `/${name}`
  }
  return name
}

const hasReasoningContent = (
  message: ChatCompletionMessage,
): message is ChatCompletionMessage & {reasoning_content: string} => {
  return typeof (message as {reasoning_content?: unknown}).reasoning_content === 'string'
}

const formatAssistantMessage = (message: ChatCompletionMessage): AssistantMessageShape => {
  const reasoningContent = hasReasoningContent(message) ? message.reasoning_content : null
  const textContent = typeof message.content === 'string' ? message.content : ''
  const content = textContent || reasoningContent || ''
  const toolCalls = message.tool_calls && message.tool_calls.length > 0 ? message.tool_calls : undefined

  return {
    role: 'assistant',
    content,
    ...(toolCalls ? {tool_calls: toolCalls} : {}),
    ...(reasoningContent ? {reasoning_content: reasoningContent} : {}),
  }
}

// How many times we should ask the model to retry if the response is invalid
const MAX_RETRIES = 2

// Helper to build a retry prompt given the base prompt, last error and response
const buildRetryPrompt = (basePrompt: string, lastError: string, lastResponse: string): string => {
  return `${basePrompt}

---

Your previous answer did not match the required JSON schema and produced the following validation error:
${lastError}

Here is your previous answer:
${lastResponse}

Please try again, ensuring you respond ONLY with valid JSON matching the schema.`
}

type ArticlesType = (typeof schema.articles.$inferSelect)[]

let abortCount = 0
let successCount = 0
let errorCount = 0

type SinglePromptInput = {
  id: string
  originalText: string
  promptHeading: string | null
  order: number | null
  type: string | null
}

/**
 * Helper to generate a single-prompt response from the LLM.
 */
const generateSinglePromptResponse = async ({
  prompt,
  baseURL,
  modelName,
}: {
  prompt: string
  baseURL: string
  modelName: string
}): Promise<{text: string; usage: {promptTokens: number; completionTokens: number; totalTokens: number}}> => {
  const client = getOpenAIClient(baseURL)
  const modelToUse = normalizeModelName(modelName)
  const response = await client.chat.completions.create({
    model: modelToUse,
    messages: [
      {role: 'system', content: SINGLE_PROMPT_SYSTEM_PROMPT},
      {role: 'user', content: prompt},
    ],
    max_completion_tokens: 2000, // Single prompt needs less tokens
    temperature: 0.1,
  })

  const message = response.choices[0]?.message
  if (!message) throw new Error('No message in response')
  const assistantMessage = formatAssistantMessage(message)

  return {
    text: assistantMessage.content,
    usage: {
      promptTokens: response.usage?.prompt_tokens || 0,
      completionTokens: response.usage?.completion_tokens || 0,
      totalTokens: response.usage?.total_tokens || 0,
    },
  }
}

/**
 * Process a single prompt for a single article.
 * This function sends one prompt at a time to the LLM, which allows for:
 * - Skipping prompts that already have judgments
 * - Better isolation of failures
 * - More granular retry logic per prompt
 * - Simpler response format (answer/explanation/quotes)
 */
export const judgeSinglePrompt = async ({
  article,
  prompt,
  sessionId,
  judgmentsJobId,
  modelConfig,
  projectId,
  contentSettings,
}: {
  article: ArticlesType[number]
  prompt: SinglePromptInput
  sessionId: string | null
  judgmentsJobId: string
  modelConfig: ModelConfigInput
  projectId: string
  contentSettings: ContentSettings
}): Promise<void> => {
  const {baseURL, modelName, modelId} = modelConfig
  if (!baseURL) {
    console.log('missing baseURL', modelConfig, baseURL)
    return
  }

  const tokenUse: JudgeTokenUsageEntry[] = []
  const startedAt = new Date().toISOString()
  const startDuration = performance.now()

  const basePrompt = judgeGetSinglePrompt(article, prompt, contentSettings)
  logFirstJudgeRequestIfNeeded({
    judgmentsJobId,
    articleId: article.id,
    promptId: prompt.id,
    baseURL,
    modelName,
    systemPrompt: SINGLE_PROMPT_SYSTEM_PROMPT,
    userPrompt: basePrompt,
    requestConfig: {temperature: 0.1, maxCompletionTokens: 2000},
  })
  const promptIds = [prompt.id]
  let userPrompt = basePrompt
  let attempts = 0
  let lastError: string | null = null
  let lastResponse = ''

  while (attempts <= MAX_RETRIES) {
    attempts += 1

    // Track current attempt's response for error handling
    let currentResponse: {
      text: string
      usage: {promptTokens: number; completionTokens: number; totalTokens: number}
    } | null = null

    try {
      currentResponse = await generateSinglePromptResponse({prompt: userPrompt, baseURL, modelName})

      // Try to parse the response - validate against prompt type
      const judgment = parseSinglePromptJudgment(currentResponse.text, prompt.type)

      // Store the judgment
      await storeSinglePromptJudgment({article, promptId: prompt.id, modelId, projectId, judgment})

      // Record success with circuit breaker
      recordConnectionSuccess(baseURL)

      tokenUse.push({
        articleId: article.id,
        promptIds,
        modelId,
        modelName,
        baseURL,
        promptTokens: currentResponse.usage.promptTokens,
        completionTokens: currentResponse.usage.completionTokens,
        totalTokens: currentResponse.usage.totalTokens,
        outcome: 'success',
        error: null,
        sanitizationAttempted: false,
        sanitizedError: null,
        sanitizedResponse: null,
        lastResponse: null,
        systemPrompt: null,
        userPrompt: null,
      })
      successCount += 1
      break
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'

      // Check if this is a connection error (server unreachable)
      // These should not be retried with a modified prompt - they need the server to be back up
      if (isConnectionError(error)) {
        recordConnectionFailure(baseURL)
        abortCount += 1
        errorCount += 1
        rateLimitedLogger.error(
          `judge:connection-error:${baseURL}`,
          `Connection error for ${baseURL} - aborting prompts`,
        )

        // Store the token use for tracking
        const duration = performance.now() - startDuration
        const finishedAt = new Date().toISOString()
        await judgeStoreTokenUse(
          [
            {
              articleId: article.id,
              promptIds,
              modelId,
              modelName,
              baseURL,
              promptTokens: 0,
              completionTokens: 0,
              totalTokens: 0,
              outcome: 'failure',
              error: 'Connection error',
              sanitizationAttempted: false,
              sanitizedError: null,
              sanitizedResponse: null,
              lastResponse: null,
              systemPrompt: SINGLE_PROMPT_SYSTEM_PROMPT,
              userPrompt,
            },
          ],
          sessionId,
          {startedAt, finishedAt, duration},
          judgmentsJobId,
          {totalRequests: 1},
        ).catch((err) => {
          console.error('judgeStoreTokenUse failed; continuing', err instanceof Error ? err.message : err)
        })

        // Throw ConnectionError to propagate to caller - prompt should NOT be marked as judged
        throw new ConnectionError(`Failed to connect to inference server: ${errorMessage}`, baseURL)
      }

      // Use actual response if available, otherwise fall back to previous response
      const responseText = currentResponse?.text ?? lastResponse
      const usage = currentResponse?.usage ?? {promptTokens: 0, completionTokens: 0, totalTokens: 0}

      // Get sanitization details for error tracking
      let sanitizationAttempted = false
      let sanitizedError: string | null = null
      let sanitizedResponse: string | null = null
      if (responseText) {
        const parseAttempt: ParseAttemptResult = tryParseJsonWithSanitization(responseText)
        if (!parseAttempt.success) {
          sanitizationAttempted = parseAttempt.sanitizationAttempted
          sanitizedError = parseAttempt.sanitizedError
          sanitizedResponse = parseAttempt.sanitizedResponse
        }
      }

      tokenUse.push({
        articleId: article.id,
        promptIds,
        modelId,
        modelName,
        baseURL,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        outcome: 'failure',
        error: errorMessage,
        sanitizationAttempted,
        sanitizedError,
        sanitizedResponse,
        lastResponse: responseText,
        systemPrompt: SINGLE_PROMPT_SYSTEM_PROMPT,
        userPrompt,
      })
      errorCount += 1

      lastError = errorMessage
      lastResponse = responseText

      if (attempts < MAX_RETRIES) {
        userPrompt = buildRetryPrompt(basePrompt, lastError, lastResponse)
      } else {
        abortCount += 1
        console.error(`${article.id} | Prompt ${prompt.id} | Aborting: ${lastError}`)
      }
    }
  }

  const duration = performance.now() - startDuration
  const finishedAt = new Date().toISOString()

  if (
    (errorCount % 100 === 0 && errorCount > 0)
    || (abortCount % 100 === 0 && abortCount > 0)
    || successCount % 100 === 0
  ) {
    console.log(`Total: ${errorCount} errorCount,${abortCount} aborts, ${successCount} successes`)
  }

  await judgeStoreTokenUse(tokenUse, sessionId, {startedAt, finishedAt, duration}, judgmentsJobId, {
    totalRequests: 1,
  }).catch((err) => {
    console.error('judgeStoreTokenUse failed; continuing', err instanceof Error ? err.message : err)
  })
}
