import {spawn} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {readLocalAppSettings} from './localAppSettings.ts'

type JsonRpcId = number

type JsonRpcErrorShape = {code: number; message: string; data?: unknown}

type JsonRpcResponse = {id: JsonRpcId; result?: unknown; error?: JsonRpcErrorShape}

type JsonRpcRequest = {id?: JsonRpcId; method: string; params?: unknown}

type JsonRpcMessage = JsonRpcResponse | JsonRpcRequest

type Pending = {resolve: (value: unknown) => void; reject: (error: unknown) => void}

type Listener = (msg: JsonRpcMessage) => void

const CODEx_DEFAULT_TIMEOUT_MS = 30_000

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
      readOnlyAccess: {type: 'restricted', includePlatformDefaults: false, readableRoots: [cwd]},
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

type CodexAppServerClient = {
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

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value && typeof value === 'object')
}

const getNumber = (value: unknown): number | null => {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const getString = (value: unknown): string | null => {
  return typeof value === 'string' ? value : null
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

export const getCodexAppServerClient = (): CodexAppServerClient => {
  if (singleton) return singleton

  let nextId = 1
  const pending = new Map<JsonRpcId, Pending>()
  const listeners = new Set<Listener>()
  const codexBin = getCodexBinPath()

  const proc = spawn(codexBin, ['app-server'], {stdio: ['pipe', 'pipe', 'pipe']})

  let rawStdout = ''
  let rawStderr = ''

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
    const trimmed = text.trim()
    if (trimmed.length > 0) console.error(`[codex] ${trimmed}`)
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

  proc.on('exit', (code, signal) => {
    const error = buildExitError(code, signal)
    pending.forEach((p) => {
      p.reject(error)
    })
    pending.clear()
    singleton = null
  })

  proc.on('error', (error) => {
    const err = new Error(
      `codex app-server failed to start (${String(error)}). Configure the Codex binary in Settings if needed.`,
    )
    pending.forEach((p) => {
      p.reject(err)
    })
    pending.clear()
    singleton = null
  })

  const send = (message: unknown): void => {
    proc.stdin.write(`${JSON.stringify(message)}\n`)
  }

  const request = async (method: string, params: unknown, timeoutMs?: number): Promise<unknown> => {
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

      send({method, id, params})
    })
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
    await request(
      'initialize',
      {
        clientInfo: {name: 'forska_ai', title: 'Forska.ai', version: '0.1.0'},
        capabilities: {
          optOutNotificationMethods: [
            'item/agentMessage/delta',
            'item/commandExecution/outputDelta',
            'item/plan/delta',
            'item/reasoning/textDelta',
            'item/reasoning/summaryTextDelta',
          ],
        },
      },
      10_000,
    )
    send({method: 'initialized', params: {}})
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
        sandboxPolicy: safe.sandboxPolicy,
        outputSchema: params.outputSchema,
      },
      params.timeoutMs,
    )
    const turnId = (turnStart as {turn?: {id?: unknown}}).turn?.id
    if (typeof turnId !== 'string') {
      throw new Error('codex app-server: turn/start missing turnId')
    }

    const turnResult = await new Promise<{text: string; usage: CodexThreadTokenUsage | null}>((resolve, reject) => {
      const timeout = setTimeout(() => {
        listeners.delete(handler)
        reject(new Error('codex app-server: turn timeout'))
      }, params.timeoutMs ?? CODEx_DEFAULT_TIMEOUT_MS)

      let turnUsage: CodexThreadTokenUsage | null = null

      const handler: Listener = (msg) => {
        const tokenUsageUpdate = getCodexThreadTokenUsageUpdate(msg)
        if (tokenUsageUpdate && tokenUsageUpdate.turnId === turnId) {
          turnUsage = tokenUsageUpdate.tokenUsage
          return undefined
        }

        if (isNotification(msg) && msg.method === 'turn/completed') {
          const completedTurnId = (msg.params as {turn?: {id?: unknown; status?: unknown; error?: unknown}} | undefined)
            ?.turn?.id
          const status = (msg.params as {turn?: {status?: unknown}} | undefined)?.turn?.status
          if (completedTurnId !== turnId) return
          clearTimeout(timeout)
          listeners.delete(handler)

          if (status === 'failed') {
            reject(new Error('codex app-server: turn failed'))
            return undefined
          }

          void request('thread/read', {threadId, includeTurns: true}, 5_000)
            .then((threadRead) => {
              resolve({text: getCodexTurnAgentMessageText(threadRead, turnId), usage: turnUsage})
            })
            .catch(reject)
        }
      }

      listeners.add(handler)
    })

    return turnResult
  }

  singleton = {modelList, runJsonTurn}
  return singleton
}
