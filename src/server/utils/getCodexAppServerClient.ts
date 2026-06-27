import {type ChildProcessWithoutNullStreams, spawn} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {readLocalAppSettings} from './localAppSettings.ts'
import {writeRuntimeLogEvent} from './runtimeLogger.ts'

type JsonRpcId = number

type JsonRpcErrorShape = {code: number; message: string; data?: unknown}

type JsonRpcResponse = {id: JsonRpcId; result?: unknown; error?: JsonRpcErrorShape}

type JsonRpcRequest = {id?: JsonRpcId; method: string; params?: unknown}

type JsonRpcMessage = JsonRpcResponse | JsonRpcRequest

type Pending = {resolve: (value: unknown) => void; reject: (error: unknown) => void}

type Listener = (msg: JsonRpcMessage) => void
type LifecycleListener = (error: Error) => void
type CodexKillSignal = Parameters<ChildProcessWithoutNullStreams['kill']>[0]

type CodexAppServerProcess = {
  on: ((event: 'error', listener: (error: Error) => void) => unknown)
    & ((event: 'exit', listener: (code: number | null, signal: string | null) => void) => unknown)
  kill?: (signal?: CodexKillSignal) => boolean
  stderr: {on: (event: 'data', listener: (data: Buffer) => void) => unknown}
  stdin: {write: (data: string) => unknown}
  stdout: {on: (event: 'data', listener: (data: Buffer) => void) => unknown}
}

export type SpawnCodexAppServer = (
  command: string,
  args: string[],
  options: {stdio: ['pipe', 'pipe', 'pipe']},
) => CodexAppServerProcess

const CODEx_DEFAULT_TIMEOUT_MS = 30_000
const CODEX_INITIALIZE_TIMEOUT_MS = 180_000
const CODEX_THREAD_READ_TIMEOUT_MS = 60_000
const CODEX_THREAD_READ_MAX_ATTEMPTS = 3
const CODEX_THREAD_READ_RETRY_DELAY_MS = 250
const CODEX_MAX_TURNS_BEFORE_RECYCLE = 25

const MAX_DEBUG_OUTPUT_CHARS = 8_000

export type CodexTokenUsageBreakdown = {
  totalTokens: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
}

export type CodexThreadTokenUsage = {
  total: CodexTokenUsageBreakdown
  last: CodexTokenUsageBreakdown
  modelContextWindow: number | null
}

export const getCodexBinPath = (): string => {
  const configuredPath = readLocalAppSettings().codexBin
  if (configuredPath) return configuredPath
  const bunGlobal = path.join(os.homedir(), '.bun', 'bin', 'codex')
  if (fs.existsSync(bunGlobal)) return bunGlobal
  const brewAppleSilicon = '/opt/homebrew/bin/codex'
  const brewIntel = '/usr/local/bin/codex'
  return fs.existsSync(brewAppleSilicon) ? brewAppleSilicon : fs.existsSync(brewIntel) ? brewIntel : 'codex'
}

const getCodexSafeCwd = (): string => {
  const dir = path.join(os.tmpdir(), 'forska-codex')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true})
  return dir
}

const isResponse = (msg: JsonRpcMessage): msg is JsonRpcResponse => {
  return 'id' in msg && !('method' in msg)
}

const isServerRequest = (msg: JsonRpcMessage): msg is JsonRpcRequest & {id: JsonRpcId} => {
  return 'method' in msg && typeof msg.id === 'number'
}

const isNotification = (msg: JsonRpcMessage): msg is JsonRpcRequest => {
  return 'method' in msg && msg.id == null
}

const shouldDeclineApproval = (method: string): boolean => {
  return method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval'
}

const buildSafeTurnConfig = () => {
  const cwd = getCodexSafeCwd()
  return {
    cwd,
    approvalPolicy: 'untrusted',
    sandboxPolicy: {
      type: 'workspaceWrite',
      writableRoots: [cwd],
      networkAccess: false,
      excludeSlashTmp: true,
      excludeTmpdirEnvVar: true,
    },
  } as const
}

type ModelListEntry = {
  id: string
  model?: string
  displayName?: string
  description?: string
  hidden?: boolean
  isDefault?: boolean
  supportedReasoningEfforts?: Array<{reasoningEffort: string; description: string}>
  defaultReasoningEffort?: string
}

type ModelListResult = {data: ModelListEntry[]; nextCursor: string | null}

export const getCodexTurnAgentMessageText = (threadReadResult: unknown, turnId: string): string => {
  const thread = (threadReadResult as {thread?: unknown} | null | undefined)?.thread
  const turns = typeof thread === 'object' && thread ? (thread as {turns?: unknown}).turns : null
  const arr = Array.isArray(turns) ? (turns as unknown[]) : []

  const turn = arr.find((value) => {
    return typeof value === 'object' && value && 'id' in value && (value as {id?: unknown}).id === turnId
  }) as {items?: unknown} | undefined
  const items = Array.isArray(turn?.items) ? (turn?.items as unknown[]) : []
  const agentItems = items.filter((i) => {
    return typeof i === 'object' && i && (i as {type?: unknown}).type === 'agentMessage'
  }) as Array<{text?: unknown}>
  const last = agentItems[agentItems.length - 1]
  return typeof last?.text === 'string' ? last.text : ''
}

const getPositiveInteger = (value: number | null | undefined, fallback: number): number => {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : fallback
}

const waitForCodexThreadReadRetry = async (delayMs: number): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, delayMs)
  })
}

const isCodexThreadReadTimeoutError = (error: unknown): boolean => {
  return error instanceof Error && error.message === 'codex app-server timeout: thread/read'
}

export type CodexAppServerClient = {
  modelList: (params?: {limit?: number; includeHidden?: boolean; cursor?: string | null}) => Promise<ModelListResult>
  runJsonTurn: (params: {
    model: string
    effort?: string | null
    inputText: string
    outputSchema: unknown
    timeoutMs?: number
  }) => Promise<{text: string; usage: CodexThreadTokenUsage | null}>
}

let singleton: CodexAppServerClient | null = null

const clearSingletonIfCurrent = (client: CodexAppServerClient | null): void => {
  if (singleton === client) {
    singleton = null
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value && typeof value === 'object')
}

const getNumber = (value: unknown): number | null => {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const getString = (value: unknown): string | null => {
  return typeof value === 'string' ? value : null
}

const getCodexErrorMessage = (value: unknown): string | null => {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }

  if (!isRecord(value)) {
    return null
  }

  const message = getString(value.message) ?? getString(value.error) ?? getString(value.details)
  if (message) return message

  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

const getCodexTurnFailedError = (value: unknown): Error => {
  const detail = getCodexErrorMessage(value)

  return new Error(detail ? `codex app-server: turn failed: ${detail}` : 'codex app-server: turn failed')
}

const getCodexTokenUsageBreakdown = (value: unknown): CodexTokenUsageBreakdown | null => {
  if (!isRecord(value)) return null

  const totalTokens = getNumber(value.totalTokens)
  const inputTokens = getNumber(value.inputTokens)
  const cachedInputTokens = getNumber(value.cachedInputTokens)
  const outputTokens = getNumber(value.outputTokens)
  const reasoningOutputTokens = getNumber(value.reasoningOutputTokens)

  return totalTokens === null
    || inputTokens === null
    || cachedInputTokens === null
    || outputTokens === null
    || reasoningOutputTokens === null
    ? null
    : {totalTokens, inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens}
}

const getCodexThreadTokenUsage = (value: unknown): CodexThreadTokenUsage | null => {
  if (!isRecord(value)) return null

  const total = getCodexTokenUsageBreakdown(value.total)
  const last = getCodexTokenUsageBreakdown(value.last)
  const modelContextWindowValue = value.modelContextWindow
  const modelContextWindow = modelContextWindowValue === null ? null : getNumber(modelContextWindowValue)

  return total === null
    || last === null
    || modelContextWindowValue === undefined
    || (modelContextWindow === null && modelContextWindowValue !== null)
    ? null
    : {total, last, modelContextWindow}
}

export const getCodexThreadTokenUsageUpdate = (
  msg: JsonRpcMessage,
): {threadId: string; tokenUsage: CodexThreadTokenUsage; turnId: string} | null => {
  if (!isNotification(msg) || msg.method !== 'thread/tokenUsage/updated' || !isRecord(msg.params)) {
    return null
  }

  const threadId = getString(msg.params.threadId)
  const turnId = getString(msg.params.turnId)
  const tokenUsage = getCodexThreadTokenUsage(msg.params.tokenUsage)

  return threadId === null || turnId === null || tokenUsage === null ? null : {threadId, tokenUsage, turnId}
}

const appendDebug = (current: string, chunk: string): string => {
  const next = (current + chunk).slice(-MAX_DEBUG_OUTPUT_CHARS)
  return next
}

type CodexStderrEvent = {key: string; message: string}

const codexTransientStderrLogIntervalMs = 60_000
const lastCodexTransientStderrLogAt = new Map<string, number>()

const getCodexResponsesWebsocketStatus = (normalized: string): number | null => {
  const status = Number(normalized.match(/http error:\s*(\d{3})/)?.[1])

  return Number.isFinite(status) ? status : null
}

const isTransientCodexResponsesWebsocketStatus = (status: number | null): boolean => {
  return status === 403 || status === 429 || (status !== null && status >= 500)
}

const getCodexResponsesWebsocketStderrEvent = (normalized: string): CodexStderrEvent | null => {
  const status = getCodexResponsesWebsocketStatus(normalized)
  const isResponsesWebsocket =
    normalized.includes('responses_websocket') && normalized.includes('backend-api/codex/responses')

  return isResponsesWebsocket && isTransientCodexResponsesWebsocketStatus(status)
    ? {
        key: `codex:responses-websocket:${status ?? 'unknown'}`,
        message: `[codex] Codex responses websocket returned HTTP ${status ?? 'unknown'}; treating as transient Codex backend availability.`,
      }
    : null
}

const getCodexCacheTtlStderrEvent = (normalized: string): CodexStderrEvent | null => {
  return normalized.includes('failed to renew cache ttl') && normalized.includes('eof while parsing a value')
    ? {
        key: 'codex:cache-ttl-renewal',
        message: '[codex] Codex model cache TTL renewal failed; treating as transient Codex cache state.',
      }
    : null
}

const getCodexModelRefreshStderrEvent = (normalized: string): CodexStderrEvent | null => {
  const isModelRefreshFailure =
    normalized.includes('codex_models_manager::manager') && normalized.includes('failed to refresh available models')
  const isLocalModelsRequestFailure =
    normalized.includes('/v1/models')
    && (normalized.includes('stream disconnected before completion')
      || normalized.includes('error sending request for url'))

  return isModelRefreshFailure && isLocalModelsRequestFailure
    ? {
        key: 'codex:model-refresh',
        message: '[codex] Codex model cache refresh failed; treating as transient Codex cache state.',
      }
    : null
}

const getCodexUpstreamResetStderrEvent = (normalized: string): CodexStderrEvent | null => {
  const hasUnexpectedContentType =
    normalized.includes('unexpected content type') || normalized.includes('unexpectedcontenttype')
  const hasUpstreamConnectFailure =
    normalized.includes('upstream connect error') || normalized.includes('transport channel closed')
  const hasConnectionReset =
    normalized.includes('disconnect/reset before headers')
    || normalized.includes('reset reason: connection termination')
    || normalized.includes('remote connection failure')
    || normalized.includes('delayed connect error: connection refused')
  const isUpstreamReset =
    normalized.includes('rmcp::transport::worker')
    && hasUnexpectedContentType
    && hasUpstreamConnectFailure
    && hasConnectionReset

  return isUpstreamReset
    ? {
        key: 'codex:upstream-reset',
        message:
          '[codex] Codex upstream connection reset while app-server worker initialized; treating as transient upstream availability.',
      }
    : null
}

const getCodexUserRejectedToolStderrEvent = (normalized: string): CodexStderrEvent | null => {
  const isUserRejected =
    normalized.includes('rejected("rejected by user")') || normalized.includes('rejected(\\"rejected by user\\")')

  return normalized.includes('codex_core::tools::router') && isUserRejected
    ? {
        key: 'codex:tool-rejected-by-user',
        message: '[codex] Codex tool command was rejected by user; treating as intentional tool permission denial.',
      }
    : null
}

const getCodexTransientStderrEvent = (value: string): CodexStderrEvent | null => {
  const normalized = value.toLowerCase()

  return (
    getCodexResponsesWebsocketStderrEvent(normalized)
    ?? getCodexCacheTtlStderrEvent(normalized)
    ?? getCodexModelRefreshStderrEvent(normalized)
    ?? getCodexUpstreamResetStderrEvent(normalized)
    ?? getCodexUserRejectedToolStderrEvent(normalized)
  )
}

const shouldLogCodexTransientStderr = (key: string): boolean => {
  const now = Date.now()
  const lastLoggedAt = lastCodexTransientStderrLogAt.get(key) ?? 0
  const shouldLog = now - lastLoggedAt >= codexTransientStderrLogIntervalMs

  if (shouldLog) {
    lastCodexTransientStderrLogAt.set(key, now)
  }

  return shouldLog
}

const logTransientCodexStderr = (event: CodexStderrEvent, stderr: string): void => {
  if (!shouldLogCodexTransientStderr(event.key)) return

  writeRuntimeLogEvent({attrs: {stderr}, event: event.key, message: event.message, severity: 'INFO'})
}

const logCodexStderr = (value: string): void => {
  const trimmed = value.trim()
  if (trimmed.length === 0) return
  const transientEvent = getCodexTransientStderrEvent(trimmed)

  if (!transientEvent) {
    console.error(`[codex] ${trimmed}`)
    return
  }

  logTransientCodexStderr(transientEvent, trimmed)
}

export const resetCodexStderrLogRateLimitForTests = (): void => {
  lastCodexTransientStderrLogAt.clear()
}

export const warmCodexAppServer = async (): Promise<void> => {
  try {
    const client = getCodexAppServerClient()
    await client.modelList({limit: 1, includeHidden: false, cursor: null})
    console.log('[codex] app-server ready')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn('[codex] app-server not ready:', message)
  }
}

export const createCodexAppServerClient = ({
  initializeTimeoutMs,
  maxTurnsBeforeRecycle,
  spawnProcess = (command, args, options) => {
    return spawn(command, args, options)
  },
  threadReadMaxAttempts,
  threadReadRetryDelayMs,
  threadReadTimeoutMs,
}: {
  initializeTimeoutMs?: number
  maxTurnsBeforeRecycle?: number
  spawnProcess?: SpawnCodexAppServer
  threadReadMaxAttempts?: number
  threadReadRetryDelayMs?: number
  threadReadTimeoutMs?: number
} = {}): CodexAppServerClient => {
  let nextId = 1
  const pending = new Map<JsonRpcId, Pending>()
  const listeners = new Set<Listener>()
  const lifecycleListeners = new Set<LifecycleListener>()
  const codexBin = getCodexBinPath()
  const resolvedInitializeTimeoutMs = getPositiveInteger(initializeTimeoutMs, CODEX_INITIALIZE_TIMEOUT_MS)
  const resolvedThreadReadMaxAttempts = getPositiveInteger(threadReadMaxAttempts, CODEX_THREAD_READ_MAX_ATTEMPTS)
  const resolvedThreadReadRetryDelayMs = getPositiveInteger(threadReadRetryDelayMs, CODEX_THREAD_READ_RETRY_DELAY_MS)
  const resolvedThreadReadTimeoutMs = getPositiveInteger(threadReadTimeoutMs, CODEX_THREAD_READ_TIMEOUT_MS)
  const resolvedMaxTurnsBeforeRecycle = getPositiveInteger(maxTurnsBeforeRecycle, CODEX_MAX_TURNS_BEFORE_RECYCLE)

  const proc = spawnProcess(codexBin, ['app-server'], {stdio: ['pipe', 'pipe', 'pipe']})

  let rawStdout = ''
  let rawStderr = ''
  let closedError: Error | null = null
  let activeTurnCount = 0
  let completedTurnCount = 0
  let recycleWhenIdle = false
  let recycleReason: 'completedLimit' | 'turnError' | null = null
  let recycleTimer: ReturnType<typeof setTimeout> | null = null
  let clientInstance: CodexAppServerClient | null = null

  let buffer = ''
  proc.stdout.on('data', (data: Buffer) => {
    rawStdout = appendDebug(rawStdout, data.toString('utf8'))
    buffer += data.toString('utf8')
    const parts = buffer.split('\n')
    buffer = parts.pop() ?? ''
    parts
      .map((line) => {
        return line.trim()
      })
      .filter((line) => {
        return line.length > 0
      })
      .forEach((line) => {
        try {
          const msg = JSON.parse(line) as JsonRpcMessage
          listeners.forEach((fn) => {
            fn(msg)
          })
        } catch (_e) {
          rawStdout = appendDebug(rawStdout, `\n${line}`)
        }
      })
  })

  proc.stderr.on('data', (data: Buffer) => {
    const text = data.toString('utf8')
    rawStderr = appendDebug(rawStderr, text)
    logCodexStderr(text)
  })

  const buildExitError = (code: number | null, signal: string | null): Error => {
    const hint =
      'Make sure OpenAI Codex is installed and supports `codex app-server`.'
      + ' If you need a different binary, configure it in Settings.'
      + ' Also run `codex login` once.'
    const details = [
      `bin=${JSON.stringify(codexBin)}`,
      `code=${String(code)}`,
      `signal=${String(signal)}`,
      rawStderr.trim().length > 0 ? `stderr=${JSON.stringify(rawStderr.trim().slice(-1000))}` : null,
      rawStdout.trim().length > 0 ? `stdout=${JSON.stringify(rawStdout.trim().slice(-1000))}` : null,
    ]
      .filter((v): v is string => {
        return typeof v === 'string'
      })
      .join(', ')
    return new Error(`codex app-server exited (${details}). ${hint}`)
  }

  const stopAppServer = (): void => {
    try {
      proc.kill?.('SIGTERM')
    } catch {
      return undefined
    }
  }

  const failAppServer = (error: Error, {stopProcess = false}: {stopProcess?: boolean} = {}): void => {
    if (closedError) return

    closedError = error
    if (stopProcess) {
      stopAppServer()
    }
    pending.forEach((p) => {
      p.reject(error)
    })
    pending.clear()
    lifecycleListeners.forEach((listener) => {
      listener(error)
    })
    lifecycleListeners.clear()
    clearSingletonIfCurrent(clientInstance)
  }

  const getRecycleError = (): Error => {
    return new Error(`codex app-server recycled after ${completedTurnCount} completed turns`)
  }

  const recycleAppServerIfIdle = (): void => {
    if (!recycleWhenIdle || activeTurnCount > 0 || closedError) return

    failAppServer(getRecycleError(), {stopProcess: true})
  }

  const scheduleRecycleAppServerIfIdle = (): void => {
    if (recycleTimer !== null) return

    recycleTimer = setTimeout(() => {
      recycleTimer = null
      recycleAppServerIfIdle()
    }, 0)
  }

  const markRecycleWhenIdle = (reason: 'completedLimit' | 'turnError'): void => {
    recycleWhenIdle = true
    recycleReason = recycleReason === 'completedLimit' ? recycleReason : reason
    clearSingletonIfCurrent(clientInstance)
    scheduleRecycleAppServerIfIdle()
  }

  const startTrackedTurn = (): void => {
    if (recycleWhenIdle && recycleReason === 'completedLimit') {
      throw getRecycleError()
    }

    activeTurnCount += 1
  }

  const finishTrackedTurn = ({completed, recycle}: {completed: boolean; recycle: boolean}): void => {
    activeTurnCount = Math.max(0, activeTurnCount - 1)
    if (completed) {
      completedTurnCount += 1
    }
    if (completedTurnCount >= resolvedMaxTurnsBeforeRecycle) {
      markRecycleWhenIdle('completedLimit')
      return
    }

    if (recycle || recycleWhenIdle) {
      markRecycleWhenIdle('turnError')
    }
  }

  proc.on('exit', (code, signal) => {
    failAppServer(buildExitError(code, signal))
  })

  proc.on('error', (error) => {
    const err = new Error(
      `codex app-server failed to start (${String(error)}). Configure the Codex binary in Settings if needed.`,
    )
    failAppServer(err)
  })

  const send = (message: unknown): void => {
    proc.stdin.write(`${JSON.stringify(message)}\n`)
  }

  const request = async (method: string, params: unknown, timeoutMs?: number): Promise<unknown> => {
    if (closedError) {
      throw closedError
    }

    const id = nextId
    nextId += 1

    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`codex app-server timeout: ${method}`))
      }, timeoutMs ?? CODEx_DEFAULT_TIMEOUT_MS)

      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout)
          pending.delete(id)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timeout)
          pending.delete(id)
          reject(error)
        },
      })

      try {
        send({method, id, params})
      } catch (error) {
        failAppServer(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  const readThreadWithRetry = async (threadId: string, attempt = 1): Promise<unknown> => {
    try {
      return await request('thread/read', {threadId, includeTurns: true}, resolvedThreadReadTimeoutMs)
    } catch (error) {
      if (!isCodexThreadReadTimeoutError(error) || attempt >= resolvedThreadReadMaxAttempts) {
        throw error
      }

      await waitForCodexThreadReadRetry(resolvedThreadReadRetryDelayMs)
      return readThreadWithRetry(threadId, attempt + 1)
    }
  }

  const onMessage = (msg: JsonRpcMessage) => {
    if (isResponse(msg)) {
      const p = pending.get(msg.id)
      if (!p) return
      return msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
    }

    if (isServerRequest(msg)) {
      if (shouldDeclineApproval(msg.method)) {
        send({id: msg.id, result: {decision: 'decline'}})
        return
      }
      send({id: msg.id, error: {code: -32601, message: `Unsupported request: ${msg.method}`}})
      return
    }

    return isNotification(msg) ? undefined : undefined
  }

  listeners.add(onMessage)

  const initialize = async (): Promise<void> => {
    try {
      await request(
        'initialize',
        {
          clientInfo: {name: 'forska_ai', title: 'Forska.ai', version: '0.1.0'},
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: [
              'item/agentMessage/delta',
              'item/commandExecution/outputDelta',
              'item/plan/delta',
              'item/reasoning/textDelta',
              'item/reasoning/summaryTextDelta',
            ],
          },
        },
        resolvedInitializeTimeoutMs,
      )
      send({method: 'initialized', params: {}})
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      failAppServer(err, {stopProcess: true})
      throw err
    }
  }

  const initPromise = initialize()

  const modelList = async (params?: {
    limit?: number
    includeHidden?: boolean
    cursor?: string | null
  }): Promise<ModelListResult> => {
    await initPromise
    const result = await request(
      'model/list',
      {limit: params?.limit ?? 200, includeHidden: params?.includeHidden ?? false, cursor: params?.cursor ?? null},
      5_000,
    )
    const raw = result as {data?: unknown; nextCursor?: unknown}
    return {
      data: Array.isArray(raw.data) ? (raw.data as ModelListEntry[]) : [],
      nextCursor: typeof raw.nextCursor === 'string' ? raw.nextCursor : null,
    }
  }

  const runJsonTurn = async (params: {
    model: string
    effort?: string | null
    inputText: string
    outputSchema: unknown
    timeoutMs?: number
  }): Promise<{text: string; usage: CodexThreadTokenUsage | null}> => {
    await initPromise

    startTrackedTurn()
    let completedTurn = false
    let recycleAfterTurn = false

    try {
      const safe = buildSafeTurnConfig()
      const started = await request('thread/start', {model: params.model, cwd: safe.cwd})
      const threadId = (started as {thread?: {id?: unknown}}).thread?.id
      if (typeof threadId !== 'string') {
        throw new Error('codex app-server: thread/start missing threadId')
      }

      const turnStart = await request(
        'turn/start',
        {
          threadId,
          input: [{type: 'text', text: params.inputText}],
          model: params.model,
          effort: params.effort ?? null,
          approvalPolicy: safe.approvalPolicy,
          cwd: safe.cwd,
          environments: [],
          sandboxPolicy: safe.sandboxPolicy,
          outputSchema: params.outputSchema,
        },
        params.timeoutMs,
      )
      const turnId = (turnStart as {turn?: {id?: unknown}}).turn?.id
      if (typeof turnId !== 'string') {
        throw new Error('codex app-server: turn/start missing turnId')
      }

      return await new Promise<{text: string; usage: CodexThreadTokenUsage | null}>((resolve, reject) => {
        let handler: Listener = () => {
          return undefined
        }
        const onClosed: LifecycleListener = (error) => {
          fail(error)
        }
        const cleanup = (): void => {
          clearTimeout(timeout)
          listeners.delete(handler)
          lifecycleListeners.delete(onClosed)
        }
        const fail = (error: Error): void => {
          cleanup()
          recycleAfterTurn = true
          reject(error)
        }
        const timeout = setTimeout(() => {
          fail(new Error('codex app-server: turn timeout'))
        }, params.timeoutMs ?? CODEx_DEFAULT_TIMEOUT_MS)

        let turnUsage: CodexThreadTokenUsage | null = null

        handler = (msg) => {
          const tokenUsageUpdate = getCodexThreadTokenUsageUpdate(msg)
          if (tokenUsageUpdate && tokenUsageUpdate.turnId === turnId) {
            turnUsage = tokenUsageUpdate.tokenUsage
            return undefined
          }

          if (isNotification(msg) && msg.method === 'turn/completed') {
            const completionParams = msg.params as
              | {error?: unknown; turn?: {error?: unknown; id?: unknown; status?: unknown}}
              | undefined
            const completedTurnId = completionParams?.turn?.id
            const status = completionParams?.turn?.status
            if (completedTurnId !== turnId) return
            cleanup()

            if (status === 'failed') {
              recycleAfterTurn = true
              reject(getCodexTurnFailedError(completionParams?.turn?.error ?? completionParams?.error))
              return undefined
            }

            void readThreadWithRetry(threadId)
              .then((threadRead) => {
                completedTurn = true
                resolve({text: getCodexTurnAgentMessageText(threadRead, turnId), usage: turnUsage})
              })
              .catch((error) => {
                recycleAfterTurn = true
                reject(error)
              })
          }
        }

        listeners.add(handler)
        lifecycleListeners.add(onClosed)

        if (closedError) {
          fail(closedError)
        }
      })
    } catch (error) {
      recycleAfterTurn = true
      throw error
    } finally {
      finishTrackedTurn({completed: completedTurn, recycle: recycleAfterTurn})
    }
  }

  const client = {modelList, runJsonTurn}
  clientInstance = client

  return client
}

export const getCodexAppServerClient = (): CodexAppServerClient => {
  if (singleton) return singleton

  singleton = createCodexAppServerClient()
  return singleton
}

export const getCodexAppServerSingletonForTests = (): CodexAppServerClient | null => {
  return singleton
}

export const setCodexAppServerSingletonForTests = (client: CodexAppServerClient | null): void => {
  singleton = client
}
