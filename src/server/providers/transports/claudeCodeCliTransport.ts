import {spawn} from 'node:child_process'
import {statSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {flattenFigureImages} from '../../fullText/figureImageEncoding.ts'
import {ensureClaudeCodeCliWorkDir, getDefaultClaudeCodeCliWorkDir} from '../../utils/claudeCodeCliHome.ts'
import {writeRuntimeLogEvent} from '../../utils/runtimeLogger.ts'
import {claudeCodeFailureCodes} from '../claudeCodeFailureCodes.ts'
import {getProviderImageBase64, getProviderPromptParts, isProviderMultipartPrompt} from '../providerImageInput.ts'
import {
  type ProviderHealthResult,
  ProviderInvocationError,
  type ProviderInvocationResult,
  type ProviderInvokeImage,
  type ProviderInvokePrompt,
  type ProviderListedModel,
  type ProviderMultipartPrompt,
  type ProviderUsageSnapshot,
} from '../providerTypes.ts'

type EnvValues = Record<string, string | undefined>

export type ClaudeCodeCliRuntime = {binPath: string; cwd: string; env: Record<string, string>; timeoutMs: number}

export type ClaudeCodeCliRun = {
  durationMs: number
  exitCode: number | null
  signal: string | null
  stderr: string
  stdout: string
  timedOut: boolean
}

export type ClaudeCodeCliStatus = {
  authMethod: string | null
  binPath: string
  cliAvailable: boolean
  email: string | null
  loggedIn: boolean
  message: string
  subscriptionType: string | null
  version: string | null
}

type ClaudeCodeCliUsage = {
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  input_tokens?: number
  output_tokens?: number
  output_tokens_details?: {thinking_tokens?: number}
}

type ClaudeCodeCliModelUsage = {
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
  inputTokens?: number
  outputTokens?: number
  thinkingTokens?: number
}

type ClaudeCodeCliResult = {
  api_error_status?: number | null
  duration_api_ms?: number
  duration_ms?: number
  is_error?: boolean
  modelUsage?: Record<string, ClaudeCodeCliModelUsage>
  num_turns?: number
  result?: string
  session_id?: string
  stop_reason?: string | null
  structured_output?: unknown
  subtype?: string
  total_cost_usd?: number
  type?: string
  usage?: ClaudeCodeCliUsage
}

type ClaudeCodeTokenCounts = {
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  inputTokens: number
  outputTokens: number
  thinkingTokens: number
}

type ClaudeCodeFailureKind = 'not_logged_in' | 'rate_limited' | 'request_failed' | 'transient' | 'usage_limit'

type ClaudeCodeInvocationContext = {effort: string | null; modelName: string}

export const claudeCodeEfforts = ['low', 'medium', 'high', 'xhigh', 'max'] as const

const claudeCodeModels = [
  {displayName: 'Claude Opus 5.5', modelName: 'claude-opus-5-5'},
  {displayName: 'Claude Sonnet 5.5', modelName: 'claude-sonnet-5-5'},
  {displayName: 'Claude Haiku 5.5', modelName: 'claude-haiku-5-5'},
]

const claudeCodeDefaultEnabledModelKeys = new Set(['claude-opus-5-5:high', 'claude-sonnet-5-5:high'])
const claudeCodeDefaultRequestTimeoutMs = 600_000
const claudeCodeStatusTimeoutMs = 10_000
const claudeCodeKillGraceMs = 5_000
const claudeCodeLogTextMaxLength = 2_000
const claudeCodeMessageTextMaxLength = 500
const strippedClaudeCodeEnvPrefixes = ['ANTHROPIC_', 'CLAUDE_CODE_USE_']
const strippedClaudeCodeEnvKeys = new Set([
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'CLAUDE_CODE_SSE_PORT',
  'MAX_THINKING_TOKENS',
])
const notLoggedInPattern =
  /not logged in|please run \/login|invalid api key|oauth token (?:has )?(?:expired|been revoked)|authentication_error/i
const usageLimitPattern = /usage limit|hit your limit|limit reached|resets? (?:at )?\d/i
const rateLimitPattern = /rate limit|too many requests|rate_limit_error/i
const transientPattern = /overloaded|internal server error|api error.*\b5\d\d\b|service unavailable|bad gateway/i
const claudeCodeJsonOutputArgs = ['--output-format', 'json']
const claudeCodeStreamJsonIoArgs = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']

const getTrimmedValue = (value: string | null | undefined): string | null => {
  const normalized = String(value ?? '').trim()

  return normalized === '' ? null : normalized
}

const getTruncatedText = (value: string | null | undefined, maxLength: number): string => {
  const text = String(value ?? '').trim()

  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text
}

const getNonNegativeNumber = (value: unknown): number => {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

const getRecord = (value: unknown): Record<string, unknown> | null => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

const getStringField = (record: Record<string, unknown> | null, key: string): string | null => {
  const value = record?.[key]

  return typeof value === 'string' ? getTrimmedValue(value) : null
}

const isExistingFile = (filePath: string): boolean => {
  return statSync(filePath, {throwIfNoEntry: false})?.isFile() ?? false
}

const getClaudeCodeBinCandidates = (envValues: EnvValues): string[] => {
  const pathEntries = String(envValues.PATH ?? '')
    .split(path.delimiter)
    .filter((entry) => {
      return entry.length > 0
    })

  return [
    ...pathEntries.map((entry) => {
      return path.join(entry, 'claude')
    }),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    path.join(os.homedir(), '.claude', 'local', 'claude'),
  ]
}

export const getClaudeCodeBinPath = (envValues: EnvValues = process.env): string => {
  return (
    getTrimmedValue(envValues.FORSKA_CLAUDE_CODE_BIN)
    ?? getClaudeCodeBinCandidates(envValues).find(isExistingFile)
    ?? 'claude'
  )
}

export const getClaudeCodeRequestTimeoutMs = (envValues: EnvValues = process.env): number => {
  const configured = Number(getTrimmedValue(envValues.FORSKA_CLAUDE_CODE_REQUEST_TIMEOUT_MS))

  return Number.isFinite(configured) && configured > 0 ? Math.trunc(configured) : claudeCodeDefaultRequestTimeoutMs
}

const isStrippedClaudeCodeEnvKey = (key: string): boolean => {
  return (
    strippedClaudeCodeEnvKeys.has(key)
    || strippedClaudeCodeEnvPrefixes.some((prefix) => {
      return key.startsWith(prefix)
    })
  )
}

export const getClaudeCodeChildEnv = (envValues: EnvValues = process.env): Record<string, string> => {
  const entries = Object.entries(envValues).filter((entry): entry is [string, string] => {
    return typeof entry[1] === 'string' && !isStrippedClaudeCodeEnvKey(entry[0])
  })

  return {...Object.fromEntries(entries), DISABLE_AUTOUPDATER: '1'}
}

export const getClaudeCodeCliRuntime = ({
  cwd,
  envValues = process.env,
}: {cwd?: string; envValues?: EnvValues} = {}): ClaudeCodeCliRuntime => {
  return {
    binPath: getClaudeCodeBinPath(envValues),
    cwd: cwd ?? getDefaultClaudeCodeCliWorkDir(),
    env: getClaudeCodeChildEnv(envValues),
    timeoutMs: getClaudeCodeRequestTimeoutMs(envValues),
  }
}

export const getClaudeCodeCliArgs = ({
  effort,
  modelName,
  outputSchema,
  streamJsonInput = false,
  systemPrompt,
}: {
  effort: string | null
  modelName: string
  outputSchema: unknown
  streamJsonInput?: boolean
  systemPrompt: string
}): string[] => {
  return [
    '-p',
    '--system-prompt',
    systemPrompt,
    ...(streamJsonInput ? claudeCodeStreamJsonIoArgs : claudeCodeJsonOutputArgs),
    ...(outputSchema == null ? [] : ['--json-schema', JSON.stringify(outputSchema)]),
    '--model',
    modelName,
    ...(effort ? ['--effort', effort] : []),
    '--no-session-persistence',
    '--max-turns',
    '1',
    '--tools',
    '',
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--permission-mode',
    'dontAsk',
  ]
}

const getAbortReason = (signal: AbortSignal): Error => {
  return signal.reason instanceof Error ? signal.reason : new Error('Claude Code request aborted')
}

export const runClaudeCodeCli = ({
  args,
  input,
  runtime,
  signal,
  timeoutMs,
}: {
  args: string[]
  input: string | null
  runtime: ClaudeCodeCliRuntime
  signal?: AbortSignal
  timeoutMs: number
}): Promise<ClaudeCodeCliRun> => {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(getAbortReason(signal))
      return
    }

    const startedAt = Date.now()
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    const state = {settled: false, timedOut: false}
    const child = spawn(runtime.binPath, args, {cwd: runtime.cwd, env: runtime.env, stdio: ['pipe', 'pipe', 'pipe']})
    const killChild = () => {
      child.kill('SIGTERM')
      setTimeout(() => {
        child.kill('SIGKILL')
      }, claudeCodeKillGraceMs).unref()
    }
    const timeout = setTimeout(() => {
      state.timedOut = true
      killChild()
    }, timeoutMs)
    const onAbort = () => {
      killChild()
      settle(() => {
        reject(getAbortReason(signal as AbortSignal))
      })
    }
    const settle = (finish: () => void) => {
      if (state.settled) return
      state.settled = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      finish()
    }

    signal?.addEventListener('abort', onAbort, {once: true})
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk)
    })
    child.stdin.on('error', () => {
      return undefined
    })
    child.on('error', (error) => {
      settle(() => {
        reject(error)
      })
    })
    child.on('close', (exitCode, exitSignal) => {
      settle(() => {
        resolve({
          durationMs: Date.now() - startedAt,
          exitCode,
          signal: exitSignal,
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          timedOut: state.timedOut,
        })
      })
    })
    child.stdin.end(input ?? '')
  })
}

const parseJsonSafely = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const getClaudeCodeResultRecord = (text: string): ClaudeCodeCliResult | null => {
  const record = getRecord(parseJsonSafely(text))

  return record?.type === 'result' ? (record as ClaudeCodeCliResult) : null
}

export const parseClaudeCodeCliResult = (stdout: string): ClaudeCodeCliResult | null => {
  const trimmed = stdout.trim()
  const lines = trimmed.split(/\r?\n/).reverse()

  return [trimmed, ...lines].reduce<ClaudeCodeCliResult | null>((found, candidate) => {
    return found ?? getClaudeCodeResultRecord(candidate)
  }, null)
}

const getClaudeCodeModelUsageTokenCounts = (modelUsage: ClaudeCodeCliResult['modelUsage']): ClaudeCodeTokenCounts => {
  return Object.values(modelUsage ?? {}).reduce<ClaudeCodeTokenCounts>(
    (totals, entry) => {
      return {
        cacheCreationInputTokens:
          totals.cacheCreationInputTokens + getNonNegativeNumber(entry.cacheCreationInputTokens),
        cacheReadInputTokens: totals.cacheReadInputTokens + getNonNegativeNumber(entry.cacheReadInputTokens),
        inputTokens: totals.inputTokens + getNonNegativeNumber(entry.inputTokens),
        outputTokens: totals.outputTokens + getNonNegativeNumber(entry.outputTokens),
        thinkingTokens: totals.thinkingTokens + getNonNegativeNumber(entry.thinkingTokens),
      }
    },
    {cacheCreationInputTokens: 0, cacheReadInputTokens: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0},
  )
}

export const getClaudeCodeTokenCounts = (result: ClaudeCodeCliResult | null): ClaudeCodeTokenCounts => {
  const usage = result?.usage
  const modelUsageCounts = getClaudeCodeModelUsageTokenCounts(result?.modelUsage)

  return usage
    ? {
        cacheCreationInputTokens: getNonNegativeNumber(usage.cache_creation_input_tokens),
        cacheReadInputTokens: getNonNegativeNumber(usage.cache_read_input_tokens),
        inputTokens: getNonNegativeNumber(usage.input_tokens),
        outputTokens: getNonNegativeNumber(usage.output_tokens),
        thinkingTokens:
          getNonNegativeNumber(usage.output_tokens_details?.thinking_tokens) || modelUsageCounts.thinkingTokens,
      }
    : modelUsageCounts
}

export const getProviderUsageFromClaudeCodeResult = (result: ClaudeCodeCliResult | null): ProviderUsageSnapshot => {
  const counts = getClaudeCodeTokenCounts(result)
  const promptTokens = counts.inputTokens + counts.cacheCreationInputTokens + counts.cacheReadInputTokens

  return {completionTokens: counts.outputTokens, promptTokens, totalTokens: promptTokens + counts.outputTokens}
}

const normalizeClaudeCodeClockTimes = (value: string): string => {
  return value.replace(/\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\b\.?/gi, (_match, hour, minute, meridiem) => {
    return `${hour}:${minute ?? '00'} ${String(meridiem).toLowerCase()}m`
  })
}

export const getClaudeCodeUsageLimitResetHint = (text: string): string | null => {
  const epochSeconds = /\|(\d{9,11})\b/.exec(text)?.[1]
  const resetsAt = /\bresets?\s+(?:at\s+)?(?<when>[^·∙•()\n]+)/i.exec(text)?.groups?.when

  return epochSeconds
    ? `resets at ${new Date(Number(epochSeconds) * 1000).toISOString()}`
    : resetsAt
      ? `resets at ${normalizeClaudeCodeClockTimes(resetsAt.trim())}`
      : null
}

export const classifyClaudeCodeFailure = ({
  apiErrorStatus,
  text,
}: {
  apiErrorStatus: number | null
  text: string
}): ClaudeCodeFailureKind => {
  return apiErrorStatus === 401 || notLoggedInPattern.test(text)
    ? 'not_logged_in'
    : usageLimitPattern.test(text)
      ? 'usage_limit'
      : apiErrorStatus === 429 || rateLimitPattern.test(text)
        ? 'rate_limited'
        : (apiErrorStatus !== null && apiErrorStatus >= 500) || transientPattern.test(text)
          ? 'transient'
          : 'request_failed'
}

const getClaudeCodeStatusLabel = (apiErrorStatus: number | null): string => {
  return apiErrorStatus === null ? '' : ` (status ${apiErrorStatus})`
}

const getClaudeCodeFailureMessage = ({
  apiErrorStatus,
  kind,
  text,
}: {
  apiErrorStatus: number | null
  kind: ClaudeCodeFailureKind
  text: string
}): string => {
  const resetHint = getClaudeCodeUsageLimitResetHint(text)
  const statusLabel = getClaudeCodeStatusLabel(apiErrorStatus)
  const messages: Record<ClaudeCodeFailureKind, string> = {
    not_logged_in: `Claude Code authentication failed${statusLabel}: ${text}. Run \`claude\` in a terminal and use /login.`,
    rate_limited: `Claude Code rate limit${statusLabel}: ${text}`,
    request_failed: `Claude Code request failed${statusLabel}: ${text}`,
    transient: `Claude Code API error${statusLabel}: ${text}`,
    usage_limit: `Claude Code usage limit reached${resetHint ? ` (${resetHint})` : ''}: ${text}`,
  }

  return messages[kind]
}

const claudeCodeFailureKindCodes: Record<ClaudeCodeFailureKind, string> = {
  not_logged_in: claudeCodeFailureCodes.notLoggedIn,
  rate_limited: claudeCodeFailureCodes.rateLimited,
  request_failed: claudeCodeFailureCodes.requestFailed,
  transient: claudeCodeFailureCodes.transient,
  usage_limit: claudeCodeFailureCodes.usageLimit,
}

const getClaudeCodeRunDiagnostics = (run: ClaudeCodeCliRun | null) => {
  return run
    ? {
        durationMs: run.durationMs,
        exitCode: run.exitCode,
        signal: run.signal,
        stderr: getTruncatedText(run.stderr, claudeCodeLogTextMaxLength),
        timedOut: run.timedOut,
      }
    : {}
}

const getClaudeCodeResultDiagnostics = (result: ClaudeCodeCliResult | null) => {
  return result
    ? {
        apiErrorStatus: result.api_error_status ?? null,
        durationApiMs: result.duration_api_ms ?? null,
        isError: result.is_error ?? null,
        numTurns: result.num_turns ?? null,
        result: getTruncatedText(result.result, claudeCodeLogTextMaxLength),
        stopReason: result.stop_reason ?? null,
        subtype: result.subtype ?? null,
        tokens: getClaudeCodeTokenCounts(result),
        totalCostUsdEstimate: result.total_cost_usd ?? null,
      }
    : {}
}

const logClaudeCodeFailure = ({
  code,
  context,
  diagnostics,
  message,
}: {
  code: string
  context: ClaudeCodeInvocationContext
  diagnostics: Record<string, unknown>
  message: string
}) => {
  writeRuntimeLogEvent({
    attrs: {...diagnostics, code, effort: context.effort, modelName: context.modelName},
    event: 'claude-code.cli.request.failed',
    message: `[claude-code] ${message}`,
    severity: 'WARN',
  })
}

const getClaudeCodeInvocationError = ({
  cause,
  code,
  context,
  message,
  result,
  run,
}: {
  cause?: unknown
  code: string
  context: ClaudeCodeInvocationContext
  message: string
  result: ClaudeCodeCliResult | null
  run: ClaudeCodeCliRun | null
}): ProviderInvocationError => {
  const diagnostics = {...getClaudeCodeRunDiagnostics(run), ...getClaudeCodeResultDiagnostics(result), message}

  logClaudeCodeFailure({code, context, diagnostics, message})

  return new ProviderInvocationError(message, {
    cause,
    code,
    diagnostics,
    providerKind: 'claude-code',
    usage: result ? getProviderUsageFromClaudeCodeResult(result) : null,
  })
}

const getClaudeCodeSpawnError = ({
  context,
  error,
  runtime,
}: {
  context: ClaudeCodeInvocationContext
  error: unknown
  runtime: ClaudeCodeCliRuntime
}): ProviderInvocationError => {
  const detail = error instanceof Error ? error.message : String(error)

  return getClaudeCodeInvocationError({
    cause: error,
    code: claudeCodeFailureCodes.cliUnavailable,
    context,
    message: `Claude Code CLI could not be started at ${runtime.binPath}: ${detail}. Install Claude Code or set FORSKA_CLAUDE_CODE_BIN.`,
    result: null,
    run: null,
  })
}

const getClaudeCodeResultFailure = ({
  context,
  result,
  run,
}: {
  context: ClaudeCodeInvocationContext
  result: ClaudeCodeCliResult
  run: ClaudeCodeCliRun
}): ProviderInvocationError => {
  const apiErrorStatus = typeof result.api_error_status === 'number' ? result.api_error_status : null
  const text =
    getTruncatedText(result.result, claudeCodeMessageTextMaxLength)
    || `subtype=${result.subtype ?? 'unknown'} stderr=${getTruncatedText(run.stderr, claudeCodeMessageTextMaxLength)}`
  const kind = classifyClaudeCodeFailure({apiErrorStatus, text})

  return getClaudeCodeInvocationError({
    code: claudeCodeFailureKindCodes[kind],
    context,
    message: getClaudeCodeFailureMessage({apiErrorStatus, kind, text}),
    result,
    run,
  })
}

const getClaudeCodeRunFailure = ({
  context,
  result,
  run,
  timeoutMs,
}: {
  context: ClaudeCodeInvocationContext
  result: ClaudeCodeCliResult | null
  run: ClaudeCodeCliRun
  timeoutMs: number
}): ProviderInvocationError | null => {
  return run.timedOut
    ? getClaudeCodeInvocationError({
        code: claudeCodeFailureCodes.transient,
        context,
        message: `Claude Code request timed out after ${timeoutMs} ms and was killed`,
        result,
        run,
      })
    : result === null
      ? getClaudeCodeInvocationError({
          code: claudeCodeFailureCodes.invalidOutput,
          context,
          message: `Claude Code CLI returned no JSON result (exit code ${String(run.exitCode)}): ${getTruncatedText(run.stdout || run.stderr, claudeCodeMessageTextMaxLength) || 'no output'}`,
          result,
          run,
        })
      : result.is_error === true || result.subtype !== 'success'
        ? getClaudeCodeResultFailure({context, result, run})
        : null
}

const getClaudeCodeResultText = (result: ClaudeCodeCliResult): string => {
  const text = typeof result.result === 'string' ? result.result.trim() : ''

  return text.length > 0 || result.structured_output == null ? text : JSON.stringify(result.structured_output)
}

const logClaudeCodeSuccess = ({
  context,
  result,
  run,
}: {
  context: ClaudeCodeInvocationContext
  result: ClaudeCodeCliResult
  run: ClaudeCodeCliRun
}) => {
  writeRuntimeLogEvent({
    attrs: {
      durationApiMs: result.duration_api_ms ?? null,
      durationMs: run.durationMs,
      effort: context.effort,
      exitCode: run.exitCode,
      modelName: context.modelName,
      numTurns: result.num_turns ?? null,
      stopReason: result.stop_reason ?? null,
      tokens: getClaudeCodeTokenCounts(result),
      totalCostUsdEstimate: result.total_cost_usd ?? null,
    },
    event: 'claude-code.cli.request.completed',
    message: `[claude-code] ${context.modelName} (effort: ${context.effort ?? 'default'}) completed in ${run.durationMs} ms`,
    severity: 'INFO',
  })
}

const getClaudeCodeInvocationResult = ({
  context,
  result,
  run,
}: {
  context: ClaudeCodeInvocationContext
  result: ClaudeCodeCliResult
  run: ClaudeCodeCliRun
}): ProviderInvocationResult => {
  const text = getClaudeCodeResultText(result)

  if (text.length === 0) {
    throw getClaudeCodeInvocationError({
      code: claudeCodeFailureCodes.emptyResponse,
      context,
      message: `Claude Code returned no result text (stop_reason=${String(result.stop_reason ?? 'null')})`,
      result,
      run,
    })
  }

  logClaudeCodeSuccess({context, result, run})

  return {
    stopReason: result.stop_reason ?? null,
    structuredOutput: result.structured_output ?? null,
    text,
    usage: getProviderUsageFromClaudeCodeResult(result),
  }
}

const getClaudeCodeImageBlock = (image: ProviderInvokeImage) => {
  return {source: {data: getProviderImageBase64(image), media_type: image.mimeType, type: 'base64'}, type: 'image'}
}

export const getClaudeCodeStreamJsonUserMessage = ({images, text}: ProviderMultipartPrompt): string => {
  const content = [{text, type: 'text'}, ...flattenFigureImages(images).map(getClaudeCodeImageBlock)]

  return `${JSON.stringify({message: {content, role: 'user'}, type: 'user'})}\n`
}

const hasClaudeCodePromptImages = (prompt: ProviderInvokePrompt): prompt is ProviderMultipartPrompt => {
  return isProviderMultipartPrompt(prompt) && prompt.images.length > 0
}

export const getClaudeCodeCliInput = (prompt: ProviderInvokePrompt): string => {
  return hasClaudeCodePromptImages(prompt)
    ? getClaudeCodeStreamJsonUserMessage(prompt)
    : getProviderPromptParts(prompt).text
}

export const invokeClaudeCodeCliModel = async ({
  effort,
  modelName,
  outputSchema,
  prompt,
  runtime = getClaudeCodeCliRuntime(),
  signal,
  systemPrompt,
}: {
  effort: string | null
  modelName: string
  outputSchema: unknown
  prompt: ProviderInvokePrompt
  runtime?: ClaudeCodeCliRuntime
  signal?: AbortSignal
  systemPrompt: string
}): Promise<ProviderInvocationResult> => {
  const context = {effort: getTrimmedValue(effort), modelName}
  const args = getClaudeCodeCliArgs({
    effort: context.effort,
    modelName,
    outputSchema,
    streamJsonInput: hasClaudeCodePromptImages(prompt),
    systemPrompt,
  })
  const cwd = await ensureClaudeCodeCliWorkDir({workDir: runtime.cwd})
  const run = await runClaudeCodeCli({
    args,
    input: getClaudeCodeCliInput(prompt),
    runtime: {...runtime, cwd},
    signal,
    timeoutMs: runtime.timeoutMs,
  }).catch((error: unknown) => {
    throw signal?.aborted ? error : getClaudeCodeSpawnError({context, error, runtime})
  })
  const result = parseClaudeCodeCliResult(run.stdout)
  const failure = getClaudeCodeRunFailure({context, result, run, timeoutMs: runtime.timeoutMs})

  if (failure || result === null) {
    throw failure ?? new Error('Claude Code CLI returned no JSON result')
  }

  return getClaudeCodeInvocationResult({context, result, run})
}

const getClaudeCodeVersion = (run: ClaudeCodeCliRun | null): string | null => {
  return run && run.exitCode === 0 ? (/\d+\.\d+\.\d+\S*/.exec(run.stdout)?.[0] ?? null) : null
}

const getClaudeCodeStatusMessage = ({
  binPath,
  email,
  loggedIn,
  subscriptionType,
  version,
}: Omit<ClaudeCodeCliStatus, 'authMethod' | 'cliAvailable' | 'message'>): string => {
  return version === null
    ? `Claude Code CLI not available at ${binPath}. Install Claude Code or set FORSKA_CLAUDE_CODE_BIN.`
    : loggedIn
      ? `Claude Code ${version} logged in as ${email ?? 'unknown account'} (${subscriptionType ?? 'unknown plan'}).`
      : `Claude Code ${version} is not logged in. Run \`claude\` in a terminal and use /login.`
}

const runClaudeCodeStatusCommand = async (runtime: ClaudeCodeCliRuntime, args: string[]) => {
  return runClaudeCodeCli({args, input: null, runtime, timeoutMs: claudeCodeStatusTimeoutMs}).catch(() => {
    return null
  })
}

export const getClaudeCodeCliStatus = async ({
  runtime = getClaudeCodeCliRuntime(),
}: {runtime?: ClaudeCodeCliRuntime} = {}): Promise<ClaudeCodeCliStatus> => {
  const cwd = await ensureClaudeCodeCliWorkDir({workDir: runtime.cwd})
  const statusRuntime = {...runtime, cwd}
  const version = getClaudeCodeVersion(await runClaudeCodeStatusCommand(statusRuntime, ['--version']))
  const authRun = version ? await runClaudeCodeStatusCommand(statusRuntime, ['auth', 'status', '--json']) : null
  const auth = getRecord(parseJsonSafely(authRun?.stdout.trim() ?? ''))
  const status = {
    authMethod: getStringField(auth, 'authMethod'),
    binPath: runtime.binPath,
    cliAvailable: version !== null,
    email: getStringField(auth, 'email'),
    loggedIn: auth?.loggedIn === true,
    subscriptionType: getStringField(auth, 'subscriptionType'),
    version,
  }

  return {...status, message: getClaudeCodeStatusMessage(status)}
}

export const getClaudeCodeHealthResult = (status: ClaudeCodeCliStatus): ProviderHealthResult => {
  return status.cliAvailable && status.loggedIn
    ? {lastError: null, message: status.message, modelCount: null, ok: true}
    : {lastError: status.message, message: status.message, modelCount: null, ok: false}
}

export const listClaudeCodeModels = (): ProviderListedModel[] => {
  const supportedReasoningEfforts = claudeCodeEfforts.map((effort) => {
    return {reasoningEffort: effort}
  })

  return claudeCodeModels.flatMap((model) => {
    return claudeCodeEfforts.map((effort) => {
      return {
        defaultEnabled: claudeCodeDefaultEnabledModelKeys.has(`${model.modelName}:${effort}`),
        displayName: `${model.displayName} (effort: ${effort})`,
        metadataJson: {
          displayName: model.displayName,
          id: model.modelName,
          reasoningEffort: effort,
          supportedReasoningEfforts,
        },
        modelName: model.modelName,
        remoteModelId: model.modelName,
        variant: effort,
        version: effort,
      }
    })
  })
}
