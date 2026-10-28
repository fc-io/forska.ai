import type {ArticleRecord, JudgmentFullTextExecution} from '../db/schemaTypes.ts'
import {
  classifyConnectionFailure,
  ConnectionError,
  type ConnectionFailure,
  createConnectionError,
  formatConnectionOutageMessage,
  isConnectionError,
  parseConnectionFailureMessage,
  recordConnectionFailure,
  recordConnectionSuccess,
} from '../server/cron/judgmentsJobs/connectionHealth.ts'
import {getJudgmentEndpointAvailability} from '../server/cron/judgmentsJobs/judgmentEndpointAvailability.ts'
import type {
  JudgmentRequestAttemptJsonEntry,
  JudgmentRequestAttemptLiveContext,
} from '../server/cron/judgmentsJobs/judgmentRequestAttemptManifest.ts'
import {getRequestAttemptManifestOwner} from '../server/cron/judgmentsJobs/judgmentRequestAttemptManifestStore.ts'
import {
  isProviderAdmissionLeaseLostError,
  updateJudgmentPromptRequestWork,
  withJudgmentRequest,
} from '../server/cron/judgmentsJobs/judgmentsRequestRuntime.ts'
import {type FullTextTokenCounter, loadFullTextTokenCounter} from '../server/fullText/fullTextTokenizer.ts'
import {claudeCodeRecoverableFailureCodes} from '../server/providers/claudeCodeFailureCodes.ts'
import {codexRateLimitedFailureCode} from '../server/providers/codexRateLimitBackoff.ts'
import {
  invokeStoredProviderModel,
  type StoredProviderInvocationContext,
} from '../server/providers/providerInvocationService.ts'
import {ProviderInvocationError, type ProviderInvokeImage} from '../server/providers/providerTypes.ts'
import {inferenceRuntimeConfig} from '../server/utils/getInferenceRuntimeConfig.ts'
import {rateLimitedLogger} from '../server/utils/rateLimitedLogger.ts'
import {FULL_TEXT_STRATEGY_NONE, type FullTextChunkPolicy} from '../utils/fullTextStrategyOptions.ts'
import {
  type FullTextChunkPlan,
  getFullTextChunkText,
  getFullTextFigureImageTokenCount,
  getFullTextFigureMarkerIndexes,
} from './judge/fullTextChunkPlan.ts'
import {
  FullTextFigureTooLargeError,
  FullTextJudgingConfigError,
  type FullTextJudgingInput,
  FullTextTooLargeError,
} from './judge/fullTextJudgingInput.ts'
import {getSinglePromptJudgmentRequest} from './judge/getSinglePromptJudgmentRequest.ts'
import {MAX_COMPLETION_TOKENS} from './judge/judgeCompletionTokens.ts'
import {
  type ContentSettings,
  type FullTextChunkJudgmentForMerge,
  getFullTextChunkJudgingUserPrompt,
  getFullTextMergeJudgingUserPrompt,
} from './judge/judgeGetPrompt.ts'
import {JudgePromptTooLargeError} from './judge/judgePromptTooLargeError.ts'
import {captureJudgmentRequestEvidence} from './judge/judgeRequestEvidence.ts'
import {judgeStoreTokenUse, type JudgeTokenUsageEntry} from './judge/judgeStoreTokenUse.ts'
import {noJudgmentFullTextExecution} from './judge/judgmentFullTextExecution.ts'
import {mapAsyncWithConcurrency} from './judge/mapAsyncWithConcurrency.ts'
import {
  type ParseAttemptResult,
  parseFullTextChunkJudgment,
  parseSinglePromptJudgment,
  type SinglePromptJudgmentResult,
  tryParseJsonWithSanitization,
} from './judge/parseSinglePromptJudgment.ts'
import {JudgmentPersistenceError, storeSinglePromptJudgment} from './judge/storeSinglePromptJudgment.ts'
import type {SystemPromptVariant} from './judge/systemPromptVariant.ts'

type ModelConfigInput = {
  modelId: string
  modelName: string
  baseURL: string
  provider: string | null
  providerConnectionId: string | null
  providerInvocationContext?: StoredProviderInvocationContext
  providerFamily?: string | null
  providerId?: string | null
  providerKey?: string | null
  providerLimit?: number | null
  providerLimitVersion?: string | null
  providerMaxInflightRequests: number | null
  providerName?: string | null
  providerUsesFamilyDefault: boolean
  resolvedDefaultCapacity?: number | null
  workerUrls: string[]
}

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

const safeJsonStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return JSON.stringify({error: `failed to serialize log payload: ${message}`})
  }
}

export const formatFirstJudgeRequestLog = ({
  judgmentsJobId,
  articleId,
  promptId,
  baseURL,
  modelName,
  requestConfig,
  systemPromptPreview,
  userPromptPreview,
}: {
  judgmentsJobId: string
  articleId: string
  promptId: string
  baseURL: string
  modelName: string
  requestConfig: {temperature: number; maxCompletionTokens: number}
  systemPromptPreview: ReturnType<typeof truncateForLog>
  userPromptPreview: ReturnType<typeof truncateForLog>
}): string => {
  return safeJsonStringify({
    judgmentsJobId,
    articleId,
    promptId,
    baseURL,
    modelName,
    normalizedModelName: normalizeModelName(modelName),
    request: {
      temperature: requestConfig.temperature,
      max_completion_tokens: requestConfig.maxCompletionTokens,
      messages: {system: systemPromptPreview.text, user: userPromptPreview.text},
      preview: {
        systemOriginalLength: systemPromptPreview.originalLength,
        systemTruncated: systemPromptPreview.truncated,
        userOriginalLength: userPromptPreview.originalLength,
        userTruncated: userPromptPreview.truncated,
      },
    },
  })
}

const getFirstRequestPreviewChars = (): number => {
  return inferenceRuntimeConfig.judgeFirstRequestPreviewChars > 0
    ? inferenceRuntimeConfig.judgeFirstRequestPreviewChars
    : 4000
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
  const shouldLogFullPrompt = inferenceRuntimeConfig.judgeFirstRequestLogFull

  // Keep this as a pre-serialized string log. Bun 1.3.x has been crashing
  // on this path when pretty-printing large nested prompt objects directly.
  console.log(
    `[judge] first-request ${formatFirstJudgeRequestLog({
      judgmentsJobId,
      articleId,
      promptId,
      baseURL,
      modelName,
      requestConfig,
      systemPromptPreview,
      userPromptPreview,
    })}`,
  )

  return shouldLogFullPrompt
    ? console.log(
        `[judge] first-request:full-user-prompt ${safeJsonStringify({
          judgmentsJobId,
          userPrompt,
          userPromptLength: userPrompt.length,
        })}`,
      )
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

const getSinglePromptOutputSchema = (): unknown => {
  return {
    type: 'object',
    properties: {
      answer: {anyOf: [{type: 'string'}, {type: 'array', items: {type: 'string'}}]},
      explanation: {type: 'string'},
      quotes: {anyOf: [{type: 'array', items: {type: 'string'}}, {type: 'null'}]},
    },
    required: ['answer', 'explanation', 'quotes'],
    additionalProperties: false,
  }
}

// How many times we should ask the model to retry if the response is invalid
const MAX_RETRIES = 2
export const maximumProviderAttemptsPerJudgeDispatch = MAX_RETRIES + 1

export {MAX_COMPLETION_TOKENS}

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

export const getRetryPromptForFailure = ({
  basePrompt,
  failureCode,
  lastError,
  lastResponse,
}: {
  basePrompt: string
  failureCode: string | null
  lastError: string
  lastResponse: string
}): string => {
  return isAnthropicEmptyResponseFailureCode(failureCode)
    ? basePrompt
    : buildRetryPrompt(basePrompt, lastError, lastResponse)
}

const buildQuoteValidationRetryPrompt = (basePrompt: string, invalidQuotes: string[], lastResponse: string): string => {
  const invalidBlock = invalidQuotes.map((q) => {
    return `- ${JSON.stringify(q)}`
  })

  return `${basePrompt}

---

Your previous answer included quote(s) that were not exact substrings of the provided record text:
${invalidBlock.join('\n')}

Here is your previous answer:
${lastResponse}

Please try again. Your quotes MUST be copied verbatim from the provided text (or return an empty array). Prefer the shortest exact supporting substrings over long passages. If only long quotes are available, return fewer quotes or an empty array instead of long passages. Your quotes may come only from the article or record text sections, never from the question, inclusion criteria, exclusion criteria, or any instructions. Do not add surrounding quotation marks unless they appear in the source text. Do not shorten quotes with ellipses. Do not include wrapper markers in quotes. If the reasoning depends on the question or criteria text but the source text has no supporting quote, return an empty array. Respond ONLY with valid JSON matching the schema.`
}

type SinglePromptJudgmentQuoteValidationResult =
  | {judgment: SinglePromptJudgmentResult; kind: 'valid'}
  | {error: string; kind: 'requeue'}
  | {error: string; kind: 'retry'; nextPrompt: string}

const invalidSinglePromptQuoteError = 'Invalid quotes: not substrings of record text'

const shouldAutoRepairNoAnswerQuotes = (answer: SinglePromptJudgmentResult['answer']): boolean => {
  return answer === 'no'
}

const isPromptSourcedInvalidQuote = ({quote, retryBasePrompt}: {quote: string; retryBasePrompt: string}): boolean => {
  const normalizedPromptText = normalizeQuoteTextForMatch(retryBasePrompt)

  return getNormalizedQuoteSubstring(quote, retryBasePrompt, normalizedPromptText) !== null
}

export const validateSinglePromptJudgmentQuotes = ({
  attempt,
  judgment,
  lastResponse,
  maxRetries,
  recordText,
  retryBasePrompt,
}: {
  attempt: number
  judgment: SinglePromptJudgmentResult
  lastResponse: string
  maxRetries: number
  recordText: string
  retryBasePrompt: string
}): SinglePromptJudgmentQuoteValidationResult => {
  const rawQuotes = Array.isArray(judgment.quotes) ? judgment.quotes : []
  const quoteValidation = getQuoteValidation(rawQuotes, recordText)
  const normalizedQuotes = dedupeStrings(quoteValidation.valid)
  const retryableInvalidQuotes = quoteValidation.invalid.filter((quote) => {
    return !isPromptSourcedInvalidQuote({quote, retryBasePrompt})
  })
  const shouldAutoRepairQuotes = shouldAutoRepairNoAnswerQuotes(judgment.answer) && retryableInvalidQuotes.length > 0

  return retryableInvalidQuotes.length === 0 || shouldAutoRepairQuotes
    ? {judgment: {...judgment, quotes: normalizedQuotes}, kind: 'valid'}
    : attempt < maxRetries
      ? {
          error: invalidSinglePromptQuoteError,
          kind: 'retry',
          nextPrompt: buildQuoteValidationRetryPrompt(retryBasePrompt, retryableInvalidQuotes, lastResponse),
        }
      : {error: invalidSinglePromptQuoteError, kind: 'requeue'}
}

const storeTokenUseAndThrowConnectionError = async ({
  tokenUse,
  sessionId,
  startedAt,
  startDuration,
  judgmentsJobId,
  articleId,
  promptIds,
  modelId,
  modelName,
  baseURL,
  systemPrompt,
  userPrompt,
  failure,
  claimId,
  queueRecordId,
  requestAttempt,
  imageEvidence = {},
  appendFailureEntry = true,
}: {
  tokenUse: JudgeTokenUsageEntry[]
  sessionId: string | null
  startedAt: string
  startDuration: number
  judgmentsJobId: string
  articleId: string
  promptIds: string[]
  modelId: string
  modelName: string
  baseURL: string
  systemPrompt: string
  userPrompt: string
  failure: ConnectionFailure
  claimId?: string | null
  queueRecordId?: string | null
  requestAttempt?: RequestAttemptTokenFields | null
  imageEvidence?: JudgeCallImageEvidence
  appendFailureEntry?: boolean
}): Promise<void> => {
  const duration = performance.now() - startDuration
  const finishedAt = new Date().toISOString()
  const entries = appendFailureEntry
    ? [
        ...tokenUse,
        {
          articleId,
          claimId: claimId ?? null,
          promptIds,
          queueRecordId: queueRecordId ?? null,
          modelId,
          modelName,
          baseURL,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          outcome: 'failure' as const,
          error: `Connection error: ${failure.message}`,
          sanitizationAttempted: false,
          sanitizedError: null,
          sanitizedResponse: null,
          lastResponse: null,
          systemPrompt,
          userPrompt,
          ...imageEvidence,
          ...(requestAttempt ?? {}),
        },
      ]
    : tokenUse

  await judgeStoreTokenUse(entries, sessionId, {startedAt, finishedAt, duration}, judgmentsJobId).catch((err) => {
    console.error('judgeStoreTokenUse failed; continuing', err instanceof Error ? err.message : err)
  })

  throw new ConnectionError(failure.message, baseURL, failure)
}

type ArticlesType = ArticleRecord[]

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

type GeneratedPromptResponse = {
  stopReason?: string | null
  text: string
  usage: {promptTokens: number; completionTokens: number; totalTokens: number}
  baseURL: string
  providerKey: string
  requestAttemptId: string
  requestFinishedAt: string
  requestStartedAt: string
}

type RequestAttemptTokenFields = {
  providerKey: string
  requestAttemptId: string
  requestFinishedAt: string
  requestStartedAt: string
}

type JudgeCallImageEvidence = Pick<JudgeTokenUsageEntry, 'imageBytes' | 'imageCount'>

/** Images attached to one provider call: their count and the bytes sent (flattened, before base64). */
export const getJudgeCallImageEvidence = (images: ProviderInvokeImage[]): JudgeCallImageEvidence => {
  return images.length === 0
    ? {}
    : {
        imageBytes: images.reduce((total, image) => {
          return total + image.bytes.byteLength
        }, 0),
        imageCount: images.length,
      }
}

const requestAttemptFieldsByError = new WeakMap<object, RequestAttemptTokenFields>()
const promptScopedProviderErrors = new WeakSet<object>()

const getRequestAttemptTokenFields = ({
  finishedAt,
  requestAttempt,
}: {
  finishedAt: string
  requestAttempt: JudgmentRequestAttemptLiveContext
}): RequestAttemptTokenFields => {
  return {
    providerKey: requestAttempt.providerKey,
    requestAttemptId: requestAttempt.requestAttemptId,
    requestFinishedAt: finishedAt,
    requestStartedAt: requestAttempt.startedAt,
  }
}

const attachRequestAttemptFieldsToError = <T>(error: T, fields: RequestAttemptTokenFields): T => {
  if (typeof error === 'object' && error !== null) {
    requestAttemptFieldsByError.set(error, fields)
  }

  return error
}

const attachPromptScopedProviderError = <T>(error: T): T => {
  if (typeof error === 'object' && error !== null) {
    promptScopedProviderErrors.add(error)
  }

  return error
}

const isJudgeConnectionError = (error: unknown): boolean => {
  return typeof error === 'object' && error !== null && promptScopedProviderErrors.has(error)
    ? false
    : isConnectionError(error)
}

const getResponseRequestAttemptFields = (response: GeneratedPromptResponse): RequestAttemptTokenFields => {
  return {
    providerKey: response.providerKey,
    requestAttemptId: response.requestAttemptId,
    requestFinishedAt: response.requestFinishedAt,
    requestStartedAt: response.requestStartedAt,
  }
}

const getErrorRequestAttemptFields = (error: unknown): RequestAttemptTokenFields | null => {
  if (typeof error !== 'object' || error === null) {
    return null
  }

  const attachedFields = requestAttemptFieldsByError.get(error)

  if (attachedFields) {
    return attachedFields
  }

  const carrier = error as Partial<RequestAttemptTokenFields>

  return carrier.providerKey && carrier.requestAttemptId && carrier.requestFinishedAt && carrier.requestStartedAt
    ? {
        providerKey: carrier.providerKey,
        requestAttemptId: carrier.requestAttemptId,
        requestFinishedAt: carrier.requestFinishedAt,
        requestStartedAt: carrier.requestStartedAt,
      }
    : null
}

const getCompletionRequestAttempt = ({
  articleId,
  claimId,
  currentResponse,
  jobId,
  promptId,
  promptIds,
  queueRecordId,
}: {
  articleId: string
  claimId?: string | null
  currentResponse: GeneratedPromptResponse
  jobId: string
  promptId: string
  promptIds: string[]
  queueRecordId: string
}): JudgmentRequestAttemptJsonEntry => {
  return {
    articleId,
    baseURL: currentResponse.baseURL,
    claimId: claimId ?? null,
    closeoutKind: 'owner_completion_body',
    completionTokens: currentResponse.usage.completionTokens,
    error: null,
    errorCode: null,
    finishedAt: currentResponse.requestFinishedAt,
    jobId,
    outcome: 'success',
    promptId,
    promptIds,
    promptTokens: currentResponse.usage.promptTokens,
    providerKey: currentResponse.providerKey,
    queueRecordId,
    requestAttemptId: currentResponse.requestAttemptId,
    startedAt: currentResponse.requestStartedAt,
    totalTokens: currentResponse.usage.totalTokens,
  }
}

export class RecoverableJudgeError extends Error {
  failureCode: string
  providerDiagnostics: unknown

  constructor(
    message: string,
    {cause, failureCode, providerDiagnostics}: {cause?: unknown; failureCode: string; providerDiagnostics?: unknown},
  ) {
    super(message, {cause})
    this.name = 'RecoverableJudgeError'
    this.failureCode = failureCode
    this.providerDiagnostics = providerDiagnostics ?? null
  }
}

const isAnthropicEmptyResponseFailureCode = (failureCode: string | null): boolean => {
  return (
    failureCode === 'anthropic_empty_response'
    || failureCode === 'anthropic_refusal_empty_response'
    || failureCode === 'anthropic_thinking_only_empty_response'
  )
}

const isRecoverableProviderFailureCode = (failureCode: string | null): boolean => {
  return (
    isAnthropicEmptyResponseFailureCode(failureCode)
    || failureCode === 'codex_transient_turn_failure'
    || failureCode === codexRateLimitedFailureCode
    || claudeCodeRecoverableFailureCodes.includes(failureCode ?? '')
  )
}

const getProviderInvocationFailureCode = (error: unknown): string | null => {
  return error instanceof ProviderInvocationError ? error.code : null
}

const getProviderInvocationDiagnostics = (error: unknown): unknown => {
  return error instanceof ProviderInvocationError ? error.diagnostics : null
}

const getProviderInvocationUsage = (
  error: unknown,
): {completionTokens: number; promptTokens: number; totalTokens: number} | null => {
  return error instanceof ProviderInvocationError ? error.usage : null
}

const getRecoverableJudgeError = ({adjustedErrorMessage, error}: {adjustedErrorMessage: string; error: unknown}) => {
  return error instanceof ProviderInvocationError && isRecoverableProviderFailureCode(error.code)
    ? new RecoverableJudgeError(adjustedErrorMessage, {
        cause: error,
        failureCode: error.code,
        providerDiagnostics: error.diagnostics,
      })
    : null
}

const getProviderEndpointPath = (providerKind: string | null): string | null => {
  return providerKind === 'openai'
    ? '/v1/responses'
    : providerKind === 'anthropic'
        || providerKind === 'codex'
        || providerKind === 'claude-code'
        || providerKind === 'docling'
        || providerKind === 'mineru'
        || providerKind === 'google'
      ? null
      : '/v1/chat/completions'
}

const classifyJudgeFailure = ({
  baseURL,
  endpointPath,
  error,
  providerKind,
}: {
  baseURL: string
  endpointPath: string | null
  error: unknown
  providerKind: string | null
}): ConnectionFailure => {
  return classifyConnectionFailure({context: {effectiveBaseURL: baseURL, endpointPath, providerKind}, error})
}

/**
 * Helper to generate a single-prompt response from the LLM.
 */
const generateSinglePromptResponse = async ({
  articleId,
  claimId,
  judgmentsJobId,
  modelId,
  promptId,
  promptIds,
  queueRecordId,
  prompt,
  images = [],
  systemPrompt,
  baseURL,
  provider,
  providerConnectionId,
  providerInvocationContext,
  providerFamily,
  providerId,
  providerKey,
  providerLimit,
  providerLimitVersion,
  providerMaxInflightRequests,
  providerName,
  providerUsesFamilyDefault,
  resolvedDefaultCapacity,
  workerUrls,
  outputSchema,
}: {
  articleId: string
  claimId?: string | null
  judgmentsJobId: string
  modelId: string
  promptId: string
  promptIds: string[]
  queueRecordId: string
  prompt: string
  images?: ProviderInvokeImage[]
  systemPrompt: string
  baseURL: string
  provider: string | null
  providerConnectionId: string | null
  providerInvocationContext?: StoredProviderInvocationContext
  providerFamily?: string | null
  providerId?: string | null
  providerKey?: string | null
  providerLimit?: number | null
  providerLimitVersion?: string | null
  providerMaxInflightRequests: number | null
  providerName?: string | null
  providerUsesFamilyDefault: boolean
  resolvedDefaultCapacity?: number | null
  workerUrls: string[]
  outputSchema: unknown
}): Promise<GeneratedPromptResponse> => {
  const endpointPath = getProviderEndpointPath(provider)

  return withJudgmentRequest(
    {
      judgmentsJobId,
      modelId,
      provider,
      fallbackBaseURL: baseURL,
      providerConnection: providerInvocationContext?.connection,
      providerConnectionId,
      providerFamily,
      providerId,
      providerKey,
      providerLimit,
      providerLimitVersion,
      providerMaxInflightRequests,
      providerName,
      providerUsesFamilyDefault,
      resolvedDefaultCapacity,
      requestAttemptManifestOwner: getRequestAttemptManifestOwner({
        articleId,
        claimId,
        jobId: judgmentsJobId,
        promptId,
        promptIds,
        queueRecordId,
      }),
      workerUrls,
    },
    async (requestBaseURL, requestAttempt) => {
      try {
        await captureJudgmentRequestEvidence({articleId, jobId: judgmentsJobId, prompt, systemPrompt})
        const result = await invokeStoredProviderModel({
          baseURLOverride: requestBaseURL,
          invocationContext: providerInvocationContext,
          maxCompletionTokens: MAX_COMPLETION_TOKENS,
          modelId,
          outputSchema,
          prompt: images.length > 0 ? {images, text: prompt} : prompt,
          signal: requestAttempt.signal,
          systemPrompt,
          temperature: 0.2,
        })
        const requestFinishedAt = new Date().toISOString()

        return {
          ...result,
          ...getRequestAttemptTokenFields({finishedAt: requestFinishedAt, requestAttempt}),
          baseURL: requestBaseURL,
        }
      } catch (error) {
        const failure = classifyJudgeFailure({baseURL: requestBaseURL, endpointPath, error, providerKind: provider})
        const requestAttemptFields = getRequestAttemptTokenFields({
          finishedAt: new Date().toISOString(),
          requestAttempt,
        })

        if (!failure.shouldPauseConnection) {
          throw attachPromptScopedProviderError(attachRequestAttemptFieldsToError(error, requestAttemptFields))
        }

        throw attachRequestAttemptFieldsToError(
          createConnectionError({
            context: {effectiveBaseURL: requestBaseURL, endpointPath, providerKind: provider},
            error,
          }),
          requestAttemptFields,
        )
      }
    },
  )
}

const OUTER_QUOTE_WRAPPER_PAIRS: Array<[string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ['`', '`'],
  ['\u201c', '\u201d'],
  ['\u2018', '\u2019'],
  ['\u00ab', '\u00bb'],
  ['\u2039', '\u203a'],
]

const htmlBoundaryTags = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'br',
  'dd',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
])

type NormalizedQuoteText = {spans: Array<{end: number; start: number}>; text: string}
type NormalizedQuoteTextBuilder = {spans: Array<{end: number; start: number}>; text: string[]}

const htmlEntityMap: Record<string, string> = {amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"'}

const quoteNormalizationTokenPattern =
  /&lt;\/?\s*[a-zA-Z][a-zA-Z0-9:-]*\b(?:(?!&gt;)[\s\S])*&gt;|<\/?\s*[a-zA-Z][a-zA-Z0-9:-]*\b[^>]*>|&(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);|[\s\S]/g

const getDecodedHtmlEntity = (entity: string): string | null => {
  const normalizedEntity = entity.trim().toLowerCase()
  const decimalValue = normalizedEntity.match(/^#(\d+)$/)
  const hexValue = normalizedEntity.match(/^#x([0-9a-f]+)$/)
  const entityValue = htmlEntityMap[normalizedEntity]

  return entityValue !== undefined
    ? entityValue
    : decimalValue
      ? String.fromCodePoint(Number(decimalValue[1]))
      : hexValue
        ? String.fromCodePoint(Number.parseInt(hexValue[1] ?? '', 16))
        : null
}

const getHtmlEntityMatch = (value: string, start: number): {end: number; text: string} | null => {
  const match = value.slice(start).match(/^&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);/)
  const decoded = match ? getDecodedHtmlEntity(match[1] ?? '') : null

  return match && decoded !== null ? {end: start + match[0].length, text: decoded} : null
}

const getHtmlTagMatch = (value: string, start: number): {end: number; tagName: string} | null => {
  const match = value.slice(start).match(/^<\/?\s*([a-zA-Z][a-zA-Z0-9:-]*)\b[^>]*>/)

  return match ? {end: start + match[0].length, tagName: (match[1] ?? '').toLowerCase()} : null
}

const getEscapedHtmlTagMatch = (value: string, start: number): {end: number; tagName: string} | null => {
  const match = value.slice(start).match(/^&lt;\/?\s*([a-zA-Z][a-zA-Z0-9:-]*)\b(?:(?!&gt;)[\s\S])*&gt;/)

  return match ? {end: start + match[0].length, tagName: (match[1] ?? '').toLowerCase()} : null
}

const getClosingHtmlTagMatch = (value: string, start: number): {end: number} | null => {
  const match = value.slice(start).match(/^<\/\s*[a-zA-Z][a-zA-Z0-9:-]*\s*>/)

  return match ? {end: start + match[0].length} : null
}

const normalizeQuoteMatchChar = (value: string): string => {
  return value
    .replace(/[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/g, ' ')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, '-')
    .toLowerCase()
}

const appendNormalizedQuoteChar = (
  normalized: NormalizedQuoteTextBuilder,
  char: string,
  start: number,
  end: number,
): NormalizedQuoteTextBuilder => {
  normalized.spans.push({end, start})
  normalized.text.push(char)

  return normalized
}

const appendNormalizedQuoteText = (
  normalized: NormalizedQuoteTextBuilder,
  text: string,
  start: number,
  end: number,
): NormalizedQuoteTextBuilder => {
  const chars = Array.from(text).map((char) => {
    return normalizeQuoteMatchChar(char)
  })

  return chars.reduce<NormalizedQuoteTextBuilder>((acc, char) => {
    const isWhitespace = /\s/.test(char)
    const normalizedChar = isWhitespace ? ' ' : char
    const shouldSkip = isWhitespace && acc.text.at(-1) === ' '

    return shouldSkip ? acc : appendNormalizedQuoteChar(acc, normalizedChar, start, end)
  }, normalized)
}

const getNormalizedQuoteText = (value: string): NormalizedQuoteText => {
  const normalized = Array.from(value.matchAll(quoteNormalizationTokenPattern)).reduce<NormalizedQuoteTextBuilder>(
    (acc, match) => {
      const token = match[0]
      const start = match.index ?? 0
      const end = start + token.length
      const tagMatch = token.startsWith('<')
        ? getHtmlTagMatch(token, 0)
        : token.startsWith('&lt;')
          ? getEscapedHtmlTagMatch(token, 0)
          : null
      const entityMatch = token.startsWith('&') ? getHtmlEntityMatch(token, 0) : null

      return tagMatch && tagMatch.end === token.length
        ? htmlBoundaryTags.has(tagMatch.tagName)
          ? appendNormalizedQuoteText(acc, ' ', start, end)
          : acc
        : entityMatch && entityMatch.end === token.length
          ? appendNormalizedQuoteText(acc, entityMatch.text, start, end)
          : appendNormalizedQuoteText(acc, token, start, end)
    },
    {spans: [], text: []},
  )
  const text = normalized.text.join('')

  return text.endsWith(' ') ? {spans: normalized.spans.slice(0, -1), text: text.trimEnd()} : {...normalized, text}
}

const extendQuoteSpanPastClosingTags = (recordText: string, end: number): number => {
  const match = getClosingHtmlTagMatch(recordText, end)

  return match ? extendQuoteSpanPastClosingTags(recordText, match.end) : end
}

const normalizeQuoteTextForMatch = (value: string): string => {
  return value.replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"')
}

const getNormalizedSourceQuoteMatch = (quote: string, recordText: string): string | null => {
  const normalizedQuote = getNormalizedQuoteText(quote)
  const normalizedRecordText = getNormalizedQuoteText(recordText)
  const matchIndex = normalizedRecordText.text.indexOf(normalizedQuote.text)
  const matchEndIndex = matchIndex + normalizedQuote.text.length - 1
  const startSpan = matchIndex >= 0 ? normalizedRecordText.spans[matchIndex] : null
  const endSpan = matchIndex >= 0 ? normalizedRecordText.spans[matchEndIndex] : null
  const rawSourceMatch = startSpan && endSpan ? recordText.slice(startSpan.start, endSpan.end) : null
  const sourceEnd =
    endSpan && rawSourceMatch?.includes('<') ? extendQuoteSpanPastClosingTags(recordText, endSpan.end) : endSpan?.end

  return startSpan && endSpan && sourceEnd !== undefined ? recordText.slice(startSpan.start, sourceEnd) : null
}

const getExactQuoteMatch = (quote: string, recordText: string, normalizedRecordText: string): string | null => {
  const rawQuote = String(quote ?? '')

  if (rawQuote.length === 0) {
    return null
  }

  if (recordText.includes(rawQuote)) {
    return rawQuote
  }

  const normalizedQuote = normalizeQuoteTextForMatch(rawQuote)
  const normalizedIndex = normalizedRecordText.indexOf(normalizedQuote)

  return normalizedIndex >= 0 ? recordText.slice(normalizedIndex, normalizedIndex + rawQuote.length) : null
}

const getNormalizedQuoteSubstring = (
  quote: string,
  recordText: string,
  normalizedRecordText: string,
): string | null => {
  const rawQuote = String(quote ?? '')

  if (rawQuote.length === 0) {
    return null
  }

  const exactMatch = getExactQuoteMatch(rawQuote, recordText, normalizedRecordText)

  if (exactMatch !== null) {
    return exactMatch
  }

  const trimmedQuote = rawQuote.trim()

  if (trimmedQuote.length > 0) {
    const trimmedMatch = getExactQuoteMatch(trimmedQuote, recordText, normalizedRecordText)

    if (trimmedMatch !== null) {
      return trimmedMatch
    }
  }

  const getNextCandidate = (value: string): string | null => {
    return OUTER_QUOTE_WRAPPER_PAIRS.reduce<string | null>((match, [open, close]) => {
      if (match !== null || !value.startsWith(open) || !value.endsWith(close)) {
        return match
      }

      const stripped = value.slice(open.length, value.length - close.length).trim()
      return stripped.length === 0 ? null : stripped
    }, null)
  }

  const tryCandidate = (value: string): string | null => {
    const nextCandidate = getNextCandidate(value)

    if (nextCandidate === null) {
      return null
    }

    const candidateMatch = getExactQuoteMatch(nextCandidate, recordText, normalizedRecordText)

    if (candidateMatch !== null) {
      return candidateMatch
    }

    return nextCandidate === value ? null : tryCandidate(nextCandidate)
  }

  return (
    tryCandidate(trimmedQuote)
    ?? (trimmedQuote.length > 0 ? getNormalizedSourceQuoteMatch(trimmedQuote, recordText) : null)
  )
}

const getQuoteValidation = (quotes: string[], recordText: string): {valid: string[]; invalid: string[]} => {
  const normalizedRecordText = normalizeQuoteTextForMatch(recordText)

  return quotes.reduce(
    (acc, quote) => {
      const rawQuote = String(quote ?? '')
      const trimmedQuote = rawQuote.trim()

      if (trimmedQuote.length === 0) {
        return acc
      }

      const normalizedQuote = getNormalizedQuoteSubstring(rawQuote, recordText, normalizedRecordText)

      return normalizedQuote === null
        ? {valid: acc.valid, invalid: [...acc.invalid, rawQuote]}
        : {valid: [...acc.valid, normalizedQuote], invalid: acc.invalid}
    },
    {valid: [] as string[], invalid: [] as string[]},
  )
}

const getRequestBaseURL = ({
  baseURL,
  currentResponse,
  error,
}: {
  baseURL: string
  currentResponse: {baseURL: string} | null
  error: unknown
}): string => {
  return error instanceof ConnectionError ? error.baseURL : (currentResponse?.baseURL ?? baseURL)
}

export const getStopReasonAdjustedErrorMessage = ({
  errorMessage,
  stopReason,
}: {
  errorMessage: string
  stopReason?: string | null
}): string => {
  const isJsonParseFailure = errorMessage.startsWith('JSON Parse error:')

  return stopReason === 'max_tokens' && isJsonParseFailure
    ? `${errorMessage} (provider stop_reason=max_tokens; response likely truncated at output cap)`
    : errorMessage
}

const dedupeStrings = (items: string[]): string[] => {
  const seen = new Set<string>()
  return items.filter((item) => {
    const v = String(item ?? '')
    if (v.length === 0) return false
    if (seen.has(v)) return false
    seen.add(v)
    return true
  })
}

export const getChunkParallelLimit = ({
  chunkCount,
  providerMaxInflightRequests,
}: {
  chunkCount: number
  providerMaxInflightRequests: number | null
}): number => {
  const configured = inferenceRuntimeConfig.judgeChunkMaxParallel > 0 ? inferenceRuntimeConfig.judgeChunkMaxParallel : 4
  const providerCap =
    providerMaxInflightRequests && providerMaxInflightRequests > 0 ? providerMaxInflightRequests : null
  return providerCap === null
    ? Math.max(1, Math.min(chunkCount, configured))
    : Math.max(1, Math.min(chunkCount, configured, providerCap))
}

type JudgeCallContext = {
  article: ArticlesType[number]
  claimId: string | null
  judgmentsJobId: string
  modelConfig: ModelConfigInput
  promptId: string
  promptIds: string[]
  queueRecordId: string
  tokenUse: JudgeTokenUsageEntry[]
}

type JudgeCallValidation<T> =
  | {kind: 'valid'; value: T}
  | {error: string; kind: 'requeue'}
  | {error: string; kind: 'retry'; nextPrompt: string}

type JudgeCallConnectionError = {
  baseURL: string
  failure: ConnectionFailure
  imageEvidence: JudgeCallImageEvidence
  kind: 'connection_error'
  requestAttempt: RequestAttemptTokenFields | null
  systemPrompt: string
  userPrompt: string
}

type JudgeCallResult<T> =
  | JudgeCallConnectionError
  | {kind: 'aborted'}
  | {error: Error; kind: 'fatal'}
  | {error: Error; kind: 'requeue'}
  | {kind: 'success'; requeueError: Error | null; value: T}

type JudgeCallInput<T> = {
  basePrompt: string
  context: JudgeCallContext
  images: ProviderInvokeImage[]
  label: string
  onValid: (value: T, response: GeneratedPromptResponse) => Promise<void>
  outputSchema: unknown
  systemPrompt: string
  validate: (input: {attempt: number; responseText: string}) => JudgeCallValidation<T>
}

type JudgeCallAttemptState = {attempt: number; lastResponse: string; requeueError: Error | null; userPrompt: string}

type JudgeOutcome = {fatalRequestError: Error | null; requeueError: Error | null}

const getTokenUseBase = (context: JudgeCallContext) => {
  return {
    articleId: context.article.id,
    claimId: context.claimId,
    modelId: context.modelConfig.modelId,
    modelName: context.modelConfig.modelName,
    promptIds: context.promptIds,
    queueRecordId: context.queueRecordId,
  }
}

const recordJudgeCallConnectionSuccess = (context: JudgeCallContext, response: GeneratedPromptResponse): void => {
  recordConnectionSuccess({
    effectiveBaseURL: response.baseURL,
    modelId: context.modelConfig.modelId,
    modelProvider: context.modelConfig.provider,
    providerConnectionId: context.modelConfig.providerConnectionId,
  })
}

const pushResponseTokenUse = ({
  context,
  error,
  images,
  pendingQueueRetry,
  response,
  systemPrompt,
  userPrompt,
}: {
  context: JudgeCallContext
  error: string | null
  images: ProviderInvokeImage[]
  pendingQueueRetry?: boolean
  response: GeneratedPromptResponse
  systemPrompt: string
  userPrompt: string
}): void => {
  context.tokenUse.push({
    ...getTokenUseBase(context),
    baseURL: response.baseURL,
    promptTokens: response.usage.promptTokens,
    completionTokens: response.usage.completionTokens,
    totalTokens: response.usage.totalTokens,
    outcome: error === null ? 'success' : 'failure',
    error,
    sanitizationAttempted: false,
    sanitizedError: null,
    sanitizedResponse: null,
    lastResponse: error === null ? null : response.text,
    systemPrompt: error === null ? null : systemPrompt,
    userPrompt: error === null ? null : userPrompt,
    ...getJudgeCallImageEvidence(images),
    ...getResponseRequestAttemptFields(response),
    ...(pendingQueueRetry ? {pendingQueueRetry} : {}),
  })
}

const getSanitizationFields = (responseText: string) => {
  const parseAttempt: ParseAttemptResult | null = responseText ? tryParseJsonWithSanitization(responseText) : null

  return parseAttempt && !parseAttempt.success
    ? {
        sanitizationAttempted: parseAttempt.sanitizationAttempted,
        sanitizedError: parseAttempt.sanitizedError,
        sanitizedResponse: parseAttempt.sanitizedResponse,
      }
    : {sanitizationAttempted: false, sanitizedError: null, sanitizedResponse: null}
}

const getJudgeCallConnectionError = ({
  context,
  currentResponse,
  error,
  images,
  requestBaseURL,
  systemPrompt,
  userPrompt,
}: {
  context: JudgeCallContext
  currentResponse: GeneratedPromptResponse | null
  error: unknown
  images: ProviderInvokeImage[]
  requestBaseURL: string
  systemPrompt: string
  userPrompt: string
}): JudgeCallConnectionError => {
  const provider = context.modelConfig.provider
  const failure = classifyJudgeFailure({
    baseURL: requestBaseURL,
    endpointPath: getProviderEndpointPath(provider),
    error,
    providerKind: provider,
  })
  const availability = getJudgmentEndpointAvailability({
    effectiveBaseURL: requestBaseURL,
    modelId: context.modelConfig.modelId,
    modelProvider: provider,
    providerConnectionId: context.modelConfig.providerConnectionId,
  })

  recordConnectionFailure({
    effectiveBaseURL: requestBaseURL,
    failure,
    modelId: context.modelConfig.modelId,
    modelProvider: provider,
    providerConnectionId: context.modelConfig.providerConnectionId,
  })
  abortCount += 1
  errorCount += 1
  rateLimitedLogger.error(
    `judge:connection-error:${failure.kind}:${requestBaseURL}`,
    formatConnectionOutageMessage({cooldownExpiresAt: availability.cooldownExpiresAt, failure}),
  )

  return {
    baseURL: requestBaseURL,
    failure,
    imageEvidence: getJudgeCallImageEvidence(images),
    kind: 'connection_error',
    requestAttempt: currentResponse
      ? getResponseRequestAttemptFields(currentResponse)
      : getErrorRequestAttemptFields(error),
    systemPrompt,
    userPrompt,
  }
}

const getNextJudgeCallStateAfterError = <T>({
  currentResponse,
  error,
  input,
  state,
}: {
  currentResponse: GeneratedPromptResponse | null
  error: unknown
  input: JudgeCallInput<T>
  state: JudgeCallAttemptState
}): JudgeCallAttemptState | {error: Error; kind: 'fatal'} => {
  const errorMessage = error instanceof Error ? error.message : 'Unknown error'
  const responseText = currentResponse?.text ?? state.lastResponse
  const adjustedErrorMessage = getStopReasonAdjustedErrorMessage({
    errorMessage,
    stopReason: currentResponse?.stopReason,
  })
  const failureCode = getProviderInvocationFailureCode(error)
  const recoverableJudgeError = getRecoverableJudgeError({adjustedErrorMessage, error})
  const requestBaseURL = getRequestBaseURL({baseURL: input.context.modelConfig.baseURL, currentResponse, error})
  const usage = currentResponse?.usage
    ?? getProviderInvocationUsage(error) ?? {promptTokens: 0, completionTokens: 0, totalTokens: 0}
  const requestAttemptFields = currentResponse
    ? getResponseRequestAttemptFields(currentResponse)
    : getErrorRequestAttemptFields(error)
  const article = input.context.article

  input.context.tokenUse.push({
    ...getTokenUseBase(input.context),
    baseURL: requestBaseURL,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    outcome: 'failure',
    error: adjustedErrorMessage,
    ...getSanitizationFields(responseText),
    lastResponse: responseText,
    systemPrompt: input.systemPrompt,
    userPrompt: state.userPrompt,
    failureCode,
    pendingQueueRetry: state.attempt >= MAX_RETRIES && recoverableJudgeError !== null,
    providerDiagnostics: getProviderInvocationDiagnostics(error),
    ...getJudgeCallImageEvidence(input.images),
    ...(requestAttemptFields ?? {}),
  })
  errorCount += 1

  if (isProviderAdmissionLeaseLostError(error)) {
    abortCount += 1
    return {error, kind: 'fatal'}
  }

  if (state.attempt >= MAX_RETRIES) {
    const connectionFailure = parseConnectionFailureMessage(adjustedErrorMessage)
    const abortMessage = connectionFailure
      ? formatConnectionOutageMessage({failure: connectionFailure})
      : adjustedErrorMessage

    abortCount += 1
    console.error(
      `${article.id} | Prompt ${input.context.promptId} | Aborting ${input.label}. ${abortMessage}${recoverableJudgeError ? ' | Requesting one extra queue retry' : ''}`,
    )
  }

  return {
    attempt: state.attempt + 1,
    lastResponse: responseText,
    requeueError: state.attempt >= MAX_RETRIES ? (state.requeueError ?? recoverableJudgeError) : state.requeueError,
    userPrompt:
      state.attempt < MAX_RETRIES
        ? getRetryPromptForFailure({
            basePrompt: input.basePrompt,
            failureCode,
            lastError: adjustedErrorMessage,
            lastResponse: responseText,
          })
        : state.userPrompt,
  }
}

const getJudgeCallResultAfterValidation = async <T>({
  input,
  response,
  state,
  validation,
}: {
  input: JudgeCallInput<T>
  response: GeneratedPromptResponse
  state: JudgeCallAttemptState
  validation: JudgeCallValidation<T>
}): Promise<JudgeCallResult<T> | JudgeCallAttemptState> => {
  if (validation.kind === 'valid') {
    await input.onValid(validation.value, response)
    recordJudgeCallConnectionSuccess(input.context, response)
    pushResponseTokenUse({
      context: input.context,
      error: null,
      images: input.images,
      response,
      systemPrompt: input.systemPrompt,
      userPrompt: state.userPrompt,
    })
    successCount += 1
    return {kind: 'success', requeueError: state.requeueError, value: validation.value}
  }

  recordJudgeCallConnectionSuccess(input.context, response)
  pushResponseTokenUse({
    context: input.context,
    error: validation.error,
    images: input.images,
    pendingQueueRetry: validation.kind === 'retry',
    response,
    systemPrompt: input.systemPrompt,
    userPrompt: state.userPrompt,
  })
  errorCount += 1

  if (validation.kind === 'retry') {
    return {...state, attempt: state.attempt + 1, lastResponse: response.text, userPrompt: validation.nextPrompt}
  }

  abortCount += 1
  console.error(
    `${input.context.article.id} | Prompt ${input.context.promptId} | Aborting ${input.label}. ${validation.error}`,
  )
  return {error: new JudgmentPersistenceError(validation.error), kind: 'requeue'}
}

const isJudgeCallAttemptState = <T>(
  value: JudgeCallResult<T> | JudgeCallAttemptState,
): value is JudgeCallAttemptState => {
  return 'attempt' in value
}

const runJudgeCallAttempt = async <T>(
  input: JudgeCallInput<T>,
  state: JudgeCallAttemptState,
): Promise<JudgeCallResult<T>> => {
  if (state.attempt > MAX_RETRIES + 1) {
    return state.requeueError ? {error: state.requeueError, kind: 'requeue'} : {kind: 'aborted'}
  }

  let currentResponse: GeneratedPromptResponse | null = null

  try {
    currentResponse = await generateSinglePromptResponse({
      articleId: input.context.article.id,
      claimId: input.context.claimId,
      judgmentsJobId: input.context.judgmentsJobId,
      modelId: input.context.modelConfig.modelId,
      promptId: input.context.promptId,
      promptIds: input.context.promptIds,
      queueRecordId: input.context.queueRecordId,
      prompt: state.userPrompt,
      images: input.images,
      systemPrompt: input.systemPrompt,
      baseURL: input.context.modelConfig.baseURL,
      provider: input.context.modelConfig.provider,
      providerConnectionId: input.context.modelConfig.providerConnectionId,
      providerInvocationContext: input.context.modelConfig.providerInvocationContext,
      providerFamily: input.context.modelConfig.providerFamily,
      providerId: input.context.modelConfig.providerId,
      providerKey: input.context.modelConfig.providerKey,
      providerLimit: input.context.modelConfig.providerLimit,
      providerLimitVersion: input.context.modelConfig.providerLimitVersion,
      providerMaxInflightRequests: input.context.modelConfig.providerMaxInflightRequests,
      providerName: input.context.modelConfig.providerName,
      providerUsesFamilyDefault: input.context.modelConfig.providerUsesFamilyDefault,
      resolvedDefaultCapacity: input.context.modelConfig.resolvedDefaultCapacity,
      workerUrls: input.context.modelConfig.workerUrls,
      outputSchema: input.outputSchema,
    })

    const validation = input.validate({attempt: state.attempt, responseText: currentResponse.text})
    const next = await getJudgeCallResultAfterValidation({input, response: currentResponse, state, validation})

    return isJudgeCallAttemptState(next) ? runJudgeCallAttempt(input, next) : next
  } catch (error) {
    const requestBaseURL = getRequestBaseURL({baseURL: input.context.modelConfig.baseURL, currentResponse, error})

    if (isJudgeConnectionError(error)) {
      return getJudgeCallConnectionError({
        context: input.context,
        currentResponse,
        error,
        images: input.images,
        requestBaseURL,
        systemPrompt: input.systemPrompt,
        userPrompt: state.userPrompt,
      })
    }

    const next = getNextJudgeCallStateAfterError({currentResponse, error, input, state})

    return isJudgeCallAttemptState(next) ? runJudgeCallAttempt(input, next) : next
  }
}

const runJudgeCall = async <T>(input: JudgeCallInput<T>): Promise<JudgeCallResult<T>> => {
  return runJudgeCallAttempt(input, {attempt: 1, lastResponse: '', requeueError: null, userPrompt: input.basePrompt})
}

type JudgeRunInput = {
  context: JudgeCallContext
  contentSettings: ContentSettings
  countTokens: FullTextTokenCounter
  fullTextStrategyId: string
  modelContext: number
  projectId: string
  prompt: SinglePromptInput
  sessionId: string | null
  startDuration: number
  startedAt: string
  storeIdentity: {
    claimIdentity?: {claimId: string; executionSnapshotHash: string; executionSnapshotId: string}
    systemPromptVariant?: SystemPromptVariant | null
  }
}

const storeJudgeResult = async ({
  fullTextExecution,
  judgment,
  response,
  run,
}: {
  fullTextExecution: JudgmentFullTextExecution
  judgment: SinglePromptJudgmentResult
  response: GeneratedPromptResponse
  run: JudgeRunInput
}): Promise<void> => {
  await storeSinglePromptJudgment({
    article: run.context.article,
    claimIdentity: run.storeIdentity.claimIdentity,
    contentSettings: run.contentSettings,
    systemPromptVariant: run.storeIdentity.systemPromptVariant,
    fullTextStrategyId: run.fullTextStrategyId,
    fullTextExecution,
    judgmentsJobId: run.context.judgmentsJobId,
    promptId: run.prompt.id,
    queueRecordId: run.context.queueRecordId,
    modelId: run.context.modelConfig.modelId,
    projectId: run.projectId,
    snapshotProjectModelName: run.context.modelConfig.modelName,
    judgment,
    chunkingStrategy: null,
    requestAttempts: [
      getCompletionRequestAttempt({
        articleId: run.context.article.id,
        claimId: run.context.claimId,
        currentResponse: response,
        jobId: run.context.judgmentsJobId,
        promptId: run.prompt.id,
        promptIds: run.context.promptIds,
        queueRecordId: run.context.queueRecordId,
      }),
    ],
  })
}

const getJudgeOutcome = async <T>(result: JudgeCallResult<T>, run: JudgeRunInput): Promise<JudgeOutcome> => {
  if (result.kind === 'connection_error') {
    await storeTokenUseAndThrowConnectionError({
      tokenUse: run.context.tokenUse,
      sessionId: run.sessionId,
      startedAt: run.startedAt,
      startDuration: run.startDuration,
      judgmentsJobId: run.context.judgmentsJobId,
      articleId: run.context.article.id,
      claimId: run.context.claimId,
      promptIds: run.context.promptIds,
      queueRecordId: run.context.queueRecordId,
      modelId: run.context.modelConfig.modelId,
      modelName: run.context.modelConfig.modelName,
      baseURL: result.baseURL,
      systemPrompt: result.systemPrompt,
      userPrompt: result.userPrompt,
      failure: result.failure,
      imageEvidence: result.imageEvidence,
      requestAttempt: result.requestAttempt,
    })
  }

  return {
    fatalRequestError: result.kind === 'fatal' ? result.error : null,
    requeueError: result.kind === 'requeue' ? result.error : result.kind === 'success' ? result.requeueError : null,
  }
}

const getPromptTokens = ({
  countTokens,
  systemPrompt,
  userPrompt,
}: {
  countTokens: FullTextTokenCounter
  systemPrompt: string
  userPrompt: string
}): number => {
  return countTokens(systemPrompt) + countTokens(userPrompt)
}

/**
 * A call fits when its prompt text tokens, the estimated tokens of the images it carries (native-images strategies
 * only; 0 otherwise) and the completion reserve fit `min(maxPromptTokens, model window)`.
 */
export const getFullTextCallMode = ({
  chunkPolicy,
  imageTokens,
  modelContext,
  promptTokens,
}: {
  chunkPolicy: FullTextChunkPolicy
  imageTokens: number
  modelContext: number
  promptTokens: number
}): 'chunked' | 'single' | 'too_large' => {
  const limit = Math.min(chunkPolicy.maxPromptTokens, modelContext)

  return promptTokens + imageTokens + MAX_COMPLETION_TOKENS <= limit
    ? 'single'
    : chunkPolicy.mode === 'chunked'
      ? 'chunked'
      : 'too_large'
}

const getCallImageTokens = (fullText: FullTextJudgingInput, text: string): number => {
  return getFullTextFigureImageTokenCount({figureImageTokens: fullText.figureImageTokens, text})
}

const getCallTokensLabel = ({
  fullText,
  imageTokens,
  promptTokens,
}: {
  fullText: FullTextJudgingInput
  imageTokens: number
  promptTokens: number
}): string => {
  return fullText.figureImageTokens === null
    ? `${promptTokens} prompt tokens`
    : `${promptTokens} prompt tokens and ${imageTokens} estimated image tokens (${fullText.strategy.imageTokenEstimateVersion})`
}

const getCallFigureImages = (fullText: FullTextJudgingInput, text: string): ProviderInvokeImage[] => {
  const imageByFigureIndex = new Map(
    fullText.figureImages.map((image) => {
      return [image.figureIndex, image] as const
    }),
  )

  return getFullTextFigureMarkerIndexes(text).flatMap((figureIndex) => {
    const image = imageByFigureIndex.get(figureIndex)

    return image ? [{bytes: image.bytes, mimeType: image.mimeType}] : []
  })
}

const runSingleJudgment = async ({
  fullTextExecution,
  images,
  request,
  run,
}: {
  fullTextExecution: JudgmentFullTextExecution
  images: ProviderInvokeImage[]
  request: ReturnType<typeof getSinglePromptJudgmentRequest>
  run: JudgeRunInput
}): Promise<JudgeOutcome> => {
  logFirstJudgeRequestIfNeeded({
    judgmentsJobId: run.context.judgmentsJobId,
    articleId: run.context.article.id,
    promptId: run.prompt.id,
    baseURL: run.context.modelConfig.baseURL,
    modelName: run.context.modelConfig.modelName,
    systemPrompt: request.systemPrompt,
    userPrompt: request.userPrompt,
    requestConfig: {temperature: 0.1, maxCompletionTokens: MAX_COMPLETION_TOKENS},
  })

  const result = await runJudgeCall<SinglePromptJudgmentResult>({
    basePrompt: request.userPrompt,
    context: run.context,
    images,
    label: 'request',
    onValid: (judgment, response) => {
      return storeJudgeResult({fullTextExecution, judgment, response, run})
    },
    outputSchema: getSinglePromptOutputSchema(),
    systemPrompt: request.systemPrompt,
    validate: ({attempt, responseText}) => {
      const validation = validateSinglePromptJudgmentQuotes({
        attempt,
        judgment: parseSinglePromptJudgment(responseText, run.prompt.type),
        lastResponse: responseText,
        maxRetries: MAX_RETRIES,
        recordText: request.recordText,
        retryBasePrompt: request.userPrompt,
      })

      return validation.kind === 'valid' ? {kind: 'valid', value: validation.judgment} : validation
    },
  })

  return getJudgeOutcome(result, run)
}

const getFullTextChunkOutputSchema = (): unknown => {
  return {
    type: 'object',
    properties: {
      answer: {anyOf: [{type: 'string'}, {type: 'array', items: {type: 'string'}}]},
      confidence: {type: 'number'},
      explanation: {type: 'string'},
      quotes: {anyOf: [{type: 'array', items: {type: 'string'}}, {type: 'null'}]},
    },
    required: ['answer', 'confidence', 'explanation', 'quotes'],
    additionalProperties: false,
  }
}

const assertPromptFitsFullTextLimit = ({
  label,
  limit,
  promptTokens,
}: {
  label: string
  limit: number
  promptTokens: number
}): void => {
  if (promptTokens + MAX_COMPLETION_TOKENS > limit) {
    throw new FullTextTooLargeError(
      `${label} needs ${promptTokens} prompt tokens plus ${MAX_COMPLETION_TOKENS} completion tokens; the limit is ${limit}.`,
    )
  }
}

type FullTextPartBudget = {chunkIndex: number; chunkText: string; imageTokens: number; promptTokens: number}

const getFigureBlocks = (chunkText: string): string[] => {
  return [...chunkText.matchAll(/[^\n]+(?:\n[^\n]+)*/g)]
    .map((match) => {
      return match[0]
    })
    .filter((block) => {
      return getFullTextFigureMarkerIndexes(block).length > 0
    })
}

/**
 * A figure block (caption plus marker) is never split and its image is never dropped. When a part overflows because
 * one figure block does not fit even as a part of its own, the article is skipped with that figure named.
 */
const assertFiguresFitOnTheirOwn = ({
  fullText,
  limit,
  part,
  partCount,
  request,
  run,
}: {
  fullText: FullTextJudgingInput
  limit: number
  part: FullTextPartBudget
  partCount: number
  request: ReturnType<typeof getSinglePromptJudgmentRequest>
  run: JudgeRunInput
}): void => {
  getFigureBlocks(part.chunkText).forEach((figureBlock) => {
    const promptTokens = getPromptTokens({
      countTokens: run.countTokens,
      systemPrompt: request.systemPrompt,
      userPrompt: getFullTextChunkJudgingUserPrompt({
        article: run.context.article,
        chunkCount: partCount,
        chunkIndex: part.chunkIndex,
        chunkText: figureBlock,
        contentSettings: run.contentSettings,
        prompt: run.prompt,
        systemPromptVariant: run.storeIdentity.systemPromptVariant,
      }),
    })
    const imageTokens = getCallImageTokens(fullText, figureBlock)

    if (promptTokens + imageTokens + MAX_COMPLETION_TOKENS > limit) {
      throw new FullTextFigureTooLargeError(
        `Figure ${getFullTextFigureMarkerIndexes(figureBlock).join(', ')} of article ${run.context.article.id} does not fit in a part of its own: it needs ${getCallTokensLabel({fullText, imageTokens, promptTokens})} plus ${MAX_COMPLETION_TOKENS} completion tokens; the limit is ${limit}. A figure is never split or sent without its image, so the article is skipped.`,
      )
    }
  })
}

const assertPartsFitFullTextLimit = ({
  fullText,
  limit,
  parts,
  request,
  run,
}: {
  fullText: FullTextJudgingInput
  limit: number
  parts: FullTextPartBudget[]
  request: ReturnType<typeof getSinglePromptJudgmentRequest>
  run: JudgeRunInput
}): void => {
  const overflowing = parts.filter((part) => {
    return part.promptTokens + part.imageTokens + MAX_COMPLETION_TOKENS > limit
  })

  overflowing.forEach((part) => {
    assertFiguresFitOnTheirOwn({fullText, limit, part, partCount: parts.length, request, run})
  })

  const [largest] = [...overflowing].sort((left, right) => {
    return right.promptTokens + right.imageTokens - (left.promptTokens + left.imageTokens)
  })

  if (largest) {
    throw new FullTextTooLargeError(
      `Part ${largest.chunkIndex + 1} of ${parts.length} of article ${run.context.article.id} needs ${getCallTokensLabel({fullText, imageTokens: largest.imageTokens, promptTokens: largest.promptTokens})} plus ${MAX_COMPLETION_TOKENS} completion tokens; the limit is ${limit}.`,
    )
  }
}

const runChunkJudgments = async ({
  chunkPrompts,
  fullText,
  plan,
  recordText,
  run,
  systemPrompt,
}: {
  chunkPrompts: string[]
  fullText: FullTextJudgingInput
  plan: FullTextChunkPlan
  recordText: string
  run: JudgeRunInput
  systemPrompt: string
}): Promise<Array<JudgeCallResult<FullTextChunkJudgmentForMerge>>> => {
  return mapAsyncWithConcurrency({
    items: chunkPrompts,
    limit: getChunkParallelLimit({
      chunkCount: chunkPrompts.length,
      providerMaxInflightRequests: run.context.modelConfig.providerMaxInflightRequests,
    }),
    mapItem: async (chunkPrompt, chunkIndex) => {
      const chunk = plan.chunks[chunkIndex]

      if (chunkIndex === 0) {
        logFirstJudgeRequestIfNeeded({
          judgmentsJobId: run.context.judgmentsJobId,
          articleId: run.context.article.id,
          promptId: run.prompt.id,
          baseURL: run.context.modelConfig.baseURL,
          modelName: run.context.modelConfig.modelName,
          systemPrompt,
          userPrompt: chunkPrompt,
          requestConfig: {temperature: 0.1, maxCompletionTokens: MAX_COMPLETION_TOKENS},
        })
      }

      return runJudgeCall<FullTextChunkJudgmentForMerge>({
        basePrompt: chunkPrompt,
        context: run.context,
        images: getCallFigureImages(
          fullText,
          chunk ? getFullTextChunkText({chunk, renderedText: fullText.renderedText}) : '',
        ),
        label: `full-text part ${chunkIndex + 1}/${chunkPrompts.length}`,
        onValid: async () => {
          return undefined
        },
        outputSchema: getFullTextChunkOutputSchema(),
        systemPrompt,
        validate: ({attempt, responseText}) => {
          const chunkJudgment = parseFullTextChunkJudgment(responseText, run.prompt.type)
          const validation = validateSinglePromptJudgmentQuotes({
            attempt,
            judgment: chunkJudgment,
            lastResponse: responseText,
            maxRetries: MAX_RETRIES,
            recordText,
            retryBasePrompt: chunkPrompt,
          })

          return validation.kind === 'valid'
            ? {
                kind: 'valid',
                value: {
                  answer: chunkJudgment.answer,
                  chunkIndex,
                  confidence: chunkJudgment.confidence,
                  explanation: chunkJudgment.explanation,
                  headingPath: chunk?.headingPath ?? null,
                  quotes: validation.judgment.quotes ?? [],
                },
              }
            : validation
        },
      })
    },
  })
}

const getChunkPhaseOutcome = async (
  results: Array<JudgeCallResult<FullTextChunkJudgmentForMerge>>,
  run: JudgeRunInput,
): Promise<{chunkJudgments: FullTextChunkJudgmentForMerge[]} | {outcome: JudgeOutcome}> => {
  const connectionError = results.find((result) => {
    return result.kind === 'connection_error'
  })
  const fatal = results.find((result) => {
    return result.kind === 'fatal'
  })
  const requeue = results.find((result) => {
    return result.kind === 'requeue'
  })
  const chunkJudgments = results.flatMap((result) => {
    return result.kind === 'success' ? [result.value] : []
  })

  if (connectionError) {
    await getJudgeOutcome(connectionError, run)
  }

  if (chunkJudgments.length < results.length && !fatal && !requeue) {
    console.error(
      `${run.context.article.id} | Prompt ${run.prompt.id} | Aborting chunked full text: ${results.length - chunkJudgments.length} of ${results.length} parts failed`,
    )
  }

  return fatal || requeue || chunkJudgments.length < results.length
    ? {
        outcome: fatal
          ? await getJudgeOutcome(fatal, run)
          : requeue
            ? await getJudgeOutcome(requeue, run)
            : {fatalRequestError: null, requeueError: null},
      }
    : {chunkJudgments}
}

const runMergeJudgment = async ({
  chunkJudgments,
  limit,
  plan,
  request,
  run,
}: {
  chunkJudgments: FullTextChunkJudgmentForMerge[]
  limit: number
  plan: FullTextChunkPlan
  request: ReturnType<typeof getSinglePromptJudgmentRequest>
  run: JudgeRunInput
}): Promise<JudgeOutcome> => {
  const mergePrompt = getFullTextMergeJudgingUserPrompt({
    article: run.context.article,
    chunkJudgments,
    contentSettings: run.contentSettings,
    prompt: run.prompt,
    systemPromptVariant: run.storeIdentity.systemPromptVariant,
  })

  assertPromptFitsFullTextLimit({
    label: `The merge request for article ${run.context.article.id}`,
    limit,
    promptTokens: getPromptTokens({
      countTokens: run.countTokens,
      systemPrompt: request.systemPrompt,
      userPrompt: mergePrompt,
    }),
  })

  const result = await runJudgeCall<SinglePromptJudgmentResult>({
    basePrompt: mergePrompt,
    context: run.context,
    images: [],
    label: 'full-text merge',
    onValid: (judgment, response) => {
      return storeJudgeResult({
        fullTextExecution: {chunkCount: plan.chunkCount, chunkPlanHash: plan.planHash, fullTextMode: 'chunked'},
        judgment,
        response,
        run,
      })
    },
    outputSchema: getSinglePromptOutputSchema(),
    systemPrompt: request.systemPrompt,
    validate: ({attempt, responseText}) => {
      const validation = validateSinglePromptJudgmentQuotes({
        attempt,
        judgment: parseSinglePromptJudgment(responseText, run.prompt.type),
        lastResponse: responseText,
        maxRetries: MAX_RETRIES,
        recordText: request.recordText,
        retryBasePrompt: mergePrompt,
      })

      return validation.kind === 'valid' ? {kind: 'valid', value: validation.judgment} : validation
    },
  })

  return getJudgeOutcome(result, run)
}

const runChunkedJudgment = async ({
  fullText,
  limit,
  request,
  run,
}: {
  fullText: FullTextJudgingInput
  limit: number
  request: ReturnType<typeof getSinglePromptJudgmentRequest>
  run: JudgeRunInput
}): Promise<JudgeOutcome> => {
  const plan = fullText.chunkPlan

  if (!plan) {
    throw new FullTextJudgingConfigError(
      `Article ${run.context.article.id} has no chunk plan for full-text strategy ${fullText.strategy.id}.`,
    )
  }

  const chunkPrompts = plan.chunks.map((chunk) => {
    return getFullTextChunkJudgingUserPrompt({
      article: run.context.article,
      chunkCount: plan.chunkCount,
      chunkIndex: chunk.index,
      chunkText: getFullTextChunkText({chunk, renderedText: fullText.renderedText}),
      contentSettings: run.contentSettings,
      prompt: run.prompt,
      systemPromptVariant: run.storeIdentity.systemPromptVariant,
    })
  })

  const parts = plan.chunks.map((chunk, chunkIndex): FullTextPartBudget => {
    const chunkText = getFullTextChunkText({chunk, renderedText: fullText.renderedText})

    return {
      chunkIndex,
      chunkText,
      imageTokens: getCallImageTokens(fullText, chunkText),
      promptTokens: getPromptTokens({
        countTokens: run.countTokens,
        systemPrompt: request.systemPrompt,
        userPrompt: chunkPrompts[chunkIndex] ?? '',
      }),
    }
  })

  assertPartsFitFullTextLimit({fullText, limit, parts, request, run})
  updateJudgmentPromptRequestWork({
    judgmentsJobId: run.context.judgmentsJobId,
    queueRecordId: run.context.queueRecordId,
    requestWorkUnits: plan.chunkCount + 1,
  })
  rateLimitedLogger.log(
    `judge:chunked-full-text:${run.context.modelConfig.baseURL}`,
    `[judge] chunked full text strategy=${fullText.strategy.id} chunks=${plan.chunkCount} plan=${plan.planHash.slice(0, 12)} limit=${limit}`,
  )

  const chunkPhase = await getChunkPhaseOutcome(
    await runChunkJudgments({
      chunkPrompts,
      fullText,
      plan,
      recordText: request.recordText,
      run,
      systemPrompt: request.systemPrompt,
    }),
    run,
  )

  return 'outcome' in chunkPhase
    ? chunkPhase.outcome
    : runMergeJudgment({chunkJudgments: chunkPhase.chunkJudgments, limit, plan, request, run})
}

const runFullTextJudgment = async ({
  fullText,
  request,
  run,
}: {
  fullText: FullTextJudgingInput
  request: ReturnType<typeof getSinglePromptJudgmentRequest>
  run: JudgeRunInput
}): Promise<JudgeOutcome> => {
  const chunkPolicy = fullText.strategy.chunkPolicy
  const promptTokens = getPromptTokens({
    countTokens: run.countTokens,
    systemPrompt: request.systemPrompt,
    userPrompt: request.userPrompt,
  })
  const imageTokens = getCallImageTokens(fullText, fullText.renderedText)
  const mode = getFullTextCallMode({chunkPolicy, imageTokens, modelContext: run.modelContext, promptTokens})
  const limit = Math.min(chunkPolicy.maxPromptTokens, run.modelContext)

  if (mode === 'too_large') {
    throw new FullTextTooLargeError(
      `Article ${run.context.article.id} needs ${getCallTokensLabel({fullText, imageTokens, promptTokens})} plus ${MAX_COMPLETION_TOKENS} completion tokens; the project's single-only chunk policy allows ${limit}.`,
    )
  }

  return mode === 'single'
    ? runSingleJudgment({
        fullTextExecution: {chunkCount: null, chunkPlanHash: null, fullTextMode: 'single'},
        images: getCallFigureImages(fullText, fullText.renderedText),
        request,
        run,
      })
    : runChunkedJudgment({fullText, limit, request, run})
}

const runTitleAbstractJudgment = async ({
  request,
  run,
}: {
  request: ReturnType<typeof getSinglePromptJudgmentRequest>
  run: JudgeRunInput
}): Promise<JudgeOutcome> => {
  const promptTokens = getPromptTokens({
    countTokens: run.countTokens,
    systemPrompt: request.systemPrompt,
    userPrompt: request.userPrompt,
  })

  if (promptTokens > run.modelContext) {
    throw new JudgePromptTooLargeError(
      `Article ${run.context.article.id} prompt needs ${promptTokens} tokens; model ${run.context.modelConfig.modelName} accepts ${run.modelContext}.`,
    )
  }

  return runSingleJudgment({fullTextExecution: noJudgmentFullTextExecution, images: [], request, run})
}

export const judgeSinglePrompt = async ({
  article,
  prompt,
  queueRecordId,
  sessionId,
  judgmentsJobId,
  modelConfig,
  modelContext,
  projectId,
  claimIdentity,
  contentSettings,
  systemPromptVariant,
  fullTextStrategyId,
  fullTextJudging = null,
}: {
  article: ArticlesType[number]
  prompt: SinglePromptInput
  queueRecordId: string
  sessionId: string | null
  judgmentsJobId: string
  modelConfig: ModelConfigInput
  modelContext: number
  projectId: string
  claimIdentity?: {claimId: string; executionSnapshotHash: string; executionSnapshotId: string}
  contentSettings: ContentSettings
  systemPromptVariant?: SystemPromptVariant | null
  fullTextStrategyId: string
  fullTextJudging?: FullTextJudgingInput | null
}): Promise<void> => {
  if (fullTextJudging === null && fullTextStrategyId !== FULL_TEXT_STRATEGY_NONE) {
    throw new FullTextJudgingConfigError(
      `Full-text strategy ${fullTextStrategyId} needs a prepared full-text judging input for article ${article.id}.`,
    )
  }

  const startedAt = new Date().toISOString()
  const startDuration = performance.now()
  const run: JudgeRunInput = {
    context: {
      article,
      claimId: claimIdentity?.claimId ?? null,
      judgmentsJobId,
      modelConfig,
      promptId: prompt.id,
      promptIds: [prompt.id],
      queueRecordId,
      tokenUse: [],
    },
    contentSettings,
    countTokens: await loadFullTextTokenCounter(),
    fullTextStrategyId,
    modelContext,
    projectId,
    prompt,
    sessionId,
    startDuration,
    startedAt,
    storeIdentity: {claimIdentity, systemPromptVariant},
  }
  const request = getSinglePromptJudgmentRequest({
    article,
    contentSettings,
    prompt,
    provider: modelConfig.provider,
    renderedFullText: fullTextJudging?.renderedText ?? null,
    systemPromptVariant,
  })
  const outcome = fullTextJudging
    ? await runFullTextJudgment({fullText: fullTextJudging, request, run})
    : await runTitleAbstractJudgment({request, run})
  const duration = performance.now() - startDuration
  const finishedAt = new Date().toISOString()

  rateLimitedLogger.log(
    'judge-progress',
    `Total: ${errorCount} errorCount,${abortCount} aborts, ${successCount} successes`,
  )

  await judgeStoreTokenUse(run.context.tokenUse, sessionId, {startedAt, finishedAt, duration}, judgmentsJobId).catch(
    (err) => {
      console.error('judgeStoreTokenUse failed; continuing', err instanceof Error ? err.message : err)
    },
  )

  if (outcome.fatalRequestError) {
    throw outcome.fatalRequestError
  }
  if (outcome.requeueError) {
    throw outcome.requeueError
  }
}
