import {EventEmitter} from 'node:events'

import {expect, mock, test} from 'bun:test'

import {
  type CodexAppServerClient,
  createCodexAppServerClient,
  getCodexAppServerSingletonForTests,
  getCodexThreadTokenUsageUpdate,
  getCodexTurnAgentMessageText,
  resetCodexStderrLogRateLimitForTests,
  setCodexAppServerSingletonForTests,
  type SpawnCodexAppServer,
} from './getCodexAppServerClient.ts'

type MockJsonRpcRequest = {
  id?: number
  method?: string
  params?: {input?: Array<{text?: string}>; sandboxPolicy?: unknown; threadId?: string}
}

type MockNotification =
  | {inputText: string; kind: 'item'; text: string}
  | {error?: unknown; inputText: string; kind: 'complete'; status: 'completed' | 'failed'}

const withCapturedConsole = async (work: () => Promise<void>) => {
  const originalError = console.error
  const originalWarn = console.warn
  const errors: unknown[][] = []
  const warnings: unknown[][] = []
  const error = mock((...args: unknown[]) => {
    errors.push(args)
  })
  const warn = mock((...args: unknown[]) => {
    warnings.push(args)
  })

  console.error = error as typeof console.error
  console.warn = warn as typeof console.warn

  try {
    await work()
    return {errors, warnings}
  } finally {
    console.error = originalError
    console.warn = originalWarn
  }
}

const createMockModelListCodexClient = () => {
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const proc = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter
    stdin: {write: (data: string) => boolean}
    stdout: EventEmitter
  }

  const send = (message: unknown) => {
    stdout.emit('data', Buffer.from(`${JSON.stringify(message)}\n`))
  }

  proc.stdout = stdout
  proc.stderr = stderr
  proc.stdin = {
    write(payload) {
      String(payload)
        .split('\n')
        .map((line) => {
          return line.trim()
        })
        .filter((line) => {
          return line.length > 0
        })
        .forEach((line) => {
          const message = JSON.parse(line) as MockJsonRpcRequest

          if (message.method === 'initialize') {
            send({id: message.id, result: {}})
            return
          }

          if (message.method === 'model/list') {
            send({id: message.id, result: {data: [], nextCursor: null}})
          }
        })

      return true
    },
  }

  const spawnProcess: SpawnCodexAppServer = () => {
    return proc
  }

  return {client: createCodexAppServerClient({spawnProcess}), stderr}
}

const createMockConcurrentCodexClient = ({
  expectedTurnCount = 2,
  maxTurnsBeforeRecycle,
  notifications,
  onTurnStart,
  threadReadTextByInputText,
}: {
  expectedTurnCount?: number
  maxTurnsBeforeRecycle?: number
  notifications: MockNotification[]
  onTurnStart?: (params: MockJsonRpcRequest['params']) => void
  threadReadTextByInputText: Record<string, string>
}) => {
  let threadCount = 0
  let turnCount = 0
  let notificationsScheduled = false
  const turnsByThreadId = new Map<string, string | null>()
  const inputTextByThreadId = new Map<string, string>()
  const turnIdByInputText = new Map<string, string>()
  const threadReadInputs: string[] = []

  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const proc = new EventEmitter() as EventEmitter & {
    kill: () => boolean
    stderr: EventEmitter
    stdin: {write: (data: string) => boolean}
    stdout: EventEmitter
  }
  let killCount = 0

  const send = (message: unknown) => {
    stdout.emit('data', Buffer.from(`${JSON.stringify(message)}\n`))
  }

  const maybeScheduleNotifications = () => {
    if (notificationsScheduled || turnsByThreadId.size !== expectedTurnCount) {
      return
    }

    const startedTurns = Array.from(turnsByThreadId.values())
    if (
      startedTurns.some((turnId) => {
        return typeof turnId !== 'string'
      })
    ) {
      return
    }

    notificationsScheduled = true

    setTimeout(() => {
      notifications.forEach((notification) => {
        if (notification.kind === 'item') {
          send({method: 'item/completed', params: {item: {type: 'agentMessage', text: notification.text}}})
          return
        }

        send({
          method: 'turn/completed',
          params: {
            turn: {
              error: notification.error,
              id: turnIdByInputText.get(notification.inputText),
              status: notification.status,
            },
          },
        })
      })
    }, 0)
  }

  proc.stdout = stdout
  proc.stderr = stderr
  proc.kill = () => {
    killCount += 1
    return true
  }
  proc.stdin = {
    write(payload) {
      String(payload)
        .split('\n')
        .map((line) => {
          return line.trim()
        })
        .filter((line) => {
          return line.length > 0
        })
        .forEach((line) => {
          const message = JSON.parse(line) as MockJsonRpcRequest

          if (message.method === 'initialize') {
            send({id: message.id, result: {}})
            return
          }

          if (message.method === 'thread/start') {
            threadCount += 1
            const threadId = `thread-${threadCount}`
            turnsByThreadId.set(threadId, null)
            send({id: message.id, result: {thread: {id: threadId}}})
            return
          }

          if (message.method === 'turn/start') {
            turnCount += 1
            const turnId = `turn-${turnCount}`
            const inputText = message.params?.input?.[0]?.text
            const threadId = message.params?.threadId
            onTurnStart?.(message.params)

            if (!threadId) {
              throw new Error('Missing threadId for turn/start')
            }

            turnsByThreadId.set(threadId, turnId)

            if (typeof inputText === 'string') {
              inputTextByThreadId.set(threadId, inputText)
              turnIdByInputText.set(inputText, turnId)
            }

            send({id: message.id, result: {turn: {id: turnId}}})
            maybeScheduleNotifications()
            return
          }

          if (message.method === 'thread/read') {
            const threadId = message.params?.threadId

            if (!threadId) {
              throw new Error('Missing threadId for thread/read')
            }

            const inputText = inputTextByThreadId.get(threadId)
            const turnId = turnsByThreadId.get(threadId)

            if (!inputText) {
              throw new Error('Missing inputText for thread/read')
            }

            threadReadInputs.push(inputText)

            send({
              id: message.id,
              result: {
                thread: {
                  turns: [
                    {id: turnId, items: [{type: 'agentMessage', text: threadReadTextByInputText[inputText] ?? ''}]},
                  ],
                },
              },
            })
          }
        })

      return true
    },
  }

  const spawnProcess: SpawnCodexAppServer = () => {
    return proc
  }

  return {
    client: createCodexAppServerClient({maxTurnsBeforeRecycle, spawnProcess}),
    getKillCount: () => {
      return killCount
    },
    threadReadInputs,
  }
}

const getNormalizedResults = (
  results: Array<PromiseSettledResult<{text: string; usage: unknown}>>,
): Array<{reason: string; status: 'rejected'} | {status: 'fulfilled'; text: string}> => {
  return results.map((result) => {
    return result.status === 'fulfilled'
      ? {status: 'fulfilled', text: result.value.text}
      : {reason: result.reason instanceof Error ? result.reason.message : String(result.reason), status: 'rejected'}
  })
}

test('getCodexThreadTokenUsageUpdate parses app-server usage notifications', () => {
  const result = getCodexThreadTokenUsageUpdate({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: 'thread-1',
      tokenUsage: {
        last: {cachedInputTokens: 4, inputTokens: 21, outputTokens: 8, reasoningOutputTokens: 3, totalTokens: 32},
        modelContextWindow: 200_000,
        total: {cachedInputTokens: 6, inputTokens: 40, outputTokens: 10, reasoningOutputTokens: 5, totalTokens: 55},
      },
      turnId: 'turn-1',
    },
  })

  expect(result).toEqual({
    threadId: 'thread-1',
    tokenUsage: {
      last: {cachedInputTokens: 4, inputTokens: 21, outputTokens: 8, reasoningOutputTokens: 3, totalTokens: 32},
      modelContextWindow: 200_000,
      total: {cachedInputTokens: 6, inputTokens: 40, outputTokens: 10, reasoningOutputTokens: 5, totalTokens: 55},
    },
    turnId: 'turn-1',
  })
})

test('getCodexThreadTokenUsageUpdate ignores unrelated notifications', () => {
  const result = getCodexThreadTokenUsageUpdate({
    method: 'turn/completed',
    params: {turn: {id: 'turn-1', status: 'completed'}},
  })

  expect(result).toBeNull()
})

test('getCodexTurnAgentMessageText returns the agent message for the requested turn', () => {
  const result = getCodexTurnAgentMessageText(
    {
      thread: {
        turns: [
          {id: 'turn-1', items: [{type: 'agentMessage', text: 'first turn answer'}]},
          {
            id: 'turn-2',
            items: [
              {type: 'agentMessage', text: 'stale answer'},
              {type: 'agentMessage', text: 'second turn answer'},
            ],
          },
        ],
      },
    },
    'turn-2',
  )

  expect(result).toBe('second turn answer')
})

test('getCodexTurnAgentMessageText does not fall back to another turn', () => {
  const result = getCodexTurnAgentMessageText(
    {thread: {turns: [{id: 'turn-1', items: [{type: 'agentMessage', text: 'other turn answer'}]}]}},
    'turn-2',
  )

  expect(result).toBe('')
})

test('runJsonTurn sends Codex-safe sandbox policy without deprecated readOnlyAccess', async () => {
  const turnStartParams: unknown[] = []
  const {client} = createMockConcurrentCodexClient({
    expectedTurnCount: 1,
    notifications: [{inputText: 'safe request', kind: 'complete', status: 'completed'}],
    onTurnStart: (params) => {
      turnStartParams.push(params)
    },
    threadReadTextByInputText: {'safe request': 'safe response'},
  })
  const result = await client.runJsonTurn({model: 'gpt-5.4', inputText: 'safe request', outputSchema: {type: 'object'}})

  expect(result.text).toBe('safe response')
  expect(turnStartParams).toHaveLength(1)
  expect(turnStartParams[0]).toMatchObject({
    environments: [],
    sandboxPolicy: {excludeSlashTmp: true, excludeTmpdirEnvVar: true, networkAccess: false, type: 'workspaceWrite'},
  })
  expect(JSON.stringify(turnStartParams[0])).not.toContain('readOnlyAccess')
})

test('modelList stops the app-server process when initialize times out', async () => {
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  let killed = false
  const proc = new EventEmitter() as EventEmitter & {
    kill: () => boolean
    stderr: EventEmitter
    stdin: {write: (data: string) => boolean}
    stdout: EventEmitter
  }

  proc.stdout = stdout
  proc.stderr = stderr
  proc.stdin = {
    write() {
      return true
    },
  }
  proc.kill = () => {
    killed = true
    return true
  }

  const spawnProcess: SpawnCodexAppServer = () => {
    return proc
  }
  const client = createCodexAppServerClient({initializeTimeoutMs: 1, spawnProcess})
  const result = await client.modelList().then(
    () => {
      return null
    },
    (error: unknown) => {
      return error
    },
  )

  expect(result).toBeInstanceOf(Error)
  expect(result instanceof Error ? result.message : '').toBe('codex app-server timeout: initialize')
  expect(killed).toBe(true)
})

test('downgrades known transient Codex stderr to rate-limited warnings', async () => {
  resetCodexStderrLogRateLimitForTests()
  const {client, stderr} = createMockModelListCodexClient()
  const captured = await withCapturedConsole(async () => {
    await client.modelList()
    stderr.emit(
      'data',
      Buffer.from(
        '2026-05-22T08:18:18.226798Z ERROR codex_models_manager::manager: failed to renew cache TTL: EOF while parsing a value at line 1 column 0\n',
      ),
    )
    stderr.emit(
      'data',
      Buffer.from(
        '2026-05-22T08:22:53.499992Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 503 Service Unavailable, url: wss://chatgpt.com/backend-api/codex/responses\n',
      ),
    )
    stderr.emit(
      'data',
      Buffer.from(
        '2026-05-22T08:30:38.081059Z ERROR rmcp::transport::worker: worker quit with fatal: Unexpected content type: Some("text/plain; body: upstream connect error or disconnect/reset before headers. reset reason: connection termination"), when send initialized notification\n',
      ),
    )
  })

  expect(captured.errors).toEqual([])
  expect(
    captured.warnings.map(([message]) => {
      return String(message)
    }),
  ).toEqual([
    '[codex] Codex model cache TTL renewal failed; treating as transient Codex cache state.',
    '[codex] Codex responses websocket returned HTTP 503; treating as transient Codex backend availability.',
    '[codex] Codex upstream connection reset while app-server worker initialized; treating as transient upstream availability.',
  ])
})

test('rate-limits repeated transient Codex stderr warnings', async () => {
  resetCodexStderrLogRateLimitForTests()
  const {client, stderr} = createMockModelListCodexClient()
  const captured = await withCapturedConsole(async () => {
    await client.modelList()
    const line =
      '2026-05-22T08:22:53.499992Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 429 Too Many Requests, url: wss://chatgpt.com/backend-api/codex/responses\n'

    stderr.emit('data', Buffer.from(line))
    stderr.emit('data', Buffer.from(line))
  })

  expect(captured.errors).toEqual([])
  expect(captured.warnings).toHaveLength(1)
  expect(String(captured.warnings[0]?.[0])).toContain('HTTP 429')
})

test('downgrades user-rejected Codex tool stderr to a warning', async () => {
  resetCodexStderrLogRateLimitForTests()
  const {client, stderr} = createMockModelListCodexClient()
  const captured = await withCapturedConsole(async () => {
    await client.modelList()
    stderr.emit(
      'data',
      Buffer.from(
        '2026-05-22T16:46:09.109860Z ERROR codex_core::tools::router: error=exec_command failed for `/bin/zsh -lc "sed -n \'196,216p\' /Users/fredrik/.codex/memories/MEMORY.md"`: CreateProcess { message: "Rejected(\\"rejected by user\\")" }\n',
      ),
    )
  })

  expect(captured.errors).toEqual([])
  expect(
    captured.warnings.map(([message]) => {
      return String(message)
    }),
  ).toEqual(['[codex] Codex tool command was rejected by user; treating as intentional tool permission denial.'])
})

test('keeps unknown Codex stderr at error level', async () => {
  resetCodexStderrLogRateLimitForTests()
  const {client, stderr} = createMockModelListCodexClient()
  const captured = await withCapturedConsole(async () => {
    await client.modelList()
    stderr.emit('data', Buffer.from('unexpected fatal stderr\n'))
  })

  expect(captured.warnings).toEqual([])
  expect(captured.errors).toHaveLength(1)
  expect(String(captured.errors[0]?.[0])).toBe('[codex] unexpected fatal stderr')
})

test('runJsonTurn keeps concurrent success scoped when another turn fails out of order', async () => {
  const {client, getKillCount} = createMockConcurrentCodexClient({
    notifications: [
      {inputText: 'success request', kind: 'item', text: 'success turn text'},
      {inputText: 'failed request', kind: 'item', text: 'failed turn partial'},
      {inputText: 'failed request', kind: 'complete', status: 'failed'},
      {inputText: 'success request', kind: 'complete', status: 'completed'},
    ],
    threadReadTextByInputText: {'failed request': 'failed turn partial', 'success request': 'success turn text'},
  })

  const results = await Promise.allSettled([
    client.runJsonTurn({model: 'gpt-5.4', inputText: 'success request', outputSchema: {type: 'object'}}),
    client.runJsonTurn({model: 'gpt-5.4', inputText: 'failed request', outputSchema: {type: 'object'}}),
  ])

  expect(getNormalizedResults(results)).toEqual([
    {status: 'fulfilled', text: 'success turn text'},
    {status: 'rejected', reason: 'codex app-server: turn failed'},
  ])
  expect(getKillCount()).toBe(1)
})

test('runJsonTurn keeps a replacement singleton when the recycled app-server drains', async () => {
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const proc = new EventEmitter() as EventEmitter & {
    kill: () => boolean
    stderr: EventEmitter
    stdin: {write: (data: string) => boolean}
    stdout: EventEmitter
  }
  const inputTextByThreadId = new Map<string, string>()
  const turnIdByInputText = new Map<string, string>()
  let killCount = 0
  let resolveTurnsStarted: () => void = () => {
    return undefined
  }
  let threadCount = 0
  let turnCount = 0
  const turnsStarted = new Promise<void>((resolve) => {
    resolveTurnsStarted = resolve
  })
  const send = (message: unknown) => {
    stdout.emit('data', Buffer.from(`${JSON.stringify(message)}\n`))
  }
  const sendCompletedTurn = (inputText: string, status: 'completed' | 'failed') => {
    send({method: 'turn/completed', params: {turn: {id: turnIdByInputText.get(inputText), status}}})
  }

  proc.stdout = stdout
  proc.stderr = stderr
  proc.kill = () => {
    killCount += 1
    return true
  }
  proc.stdin = {
    write(payload) {
      String(payload)
        .split('\n')
        .map((line) => {
          return line.trim()
        })
        .filter((line) => {
          return line.length > 0
        })
        .forEach((line) => {
          const message = JSON.parse(line) as MockJsonRpcRequest

          if (message.method === 'initialize') {
            send({id: message.id, result: {}})
            return
          }

          if (message.method === 'thread/start') {
            threadCount += 1
            send({id: message.id, result: {thread: {id: `thread-${threadCount}`}}})
            return
          }

          if (message.method === 'turn/start') {
            turnCount += 1
            const threadId = message.params?.threadId
            const inputText = message.params?.input?.[0]?.text
            if (!threadId || typeof inputText !== 'string') {
              throw new Error('Missing turn/start test params')
            }

            const turnId = `turn-${turnCount}`
            inputTextByThreadId.set(threadId, inputText)
            turnIdByInputText.set(inputText, turnId)
            send({id: message.id, result: {turn: {id: turnId}}})

            if (turnCount === 2) {
              setTimeout(resolveTurnsStarted, 0)
            }
            return
          }

          if (message.method === 'thread/read') {
            const threadId = message.params?.threadId
            const inputText = typeof threadId === 'string' ? inputTextByThreadId.get(threadId) : null
            const turnId = inputText ? turnIdByInputText.get(inputText) : null

            send({
              id: message.id,
              result: {thread: {turns: [{id: turnId, items: [{type: 'agentMessage', text: `${inputText} response`}]}]}},
            })
          }
        })

      return true
    },
  }

  const spawnProcess: SpawnCodexAppServer = () => {
    return proc
  }
  const oldClient = createCodexAppServerClient({spawnProcess})
  const replacementClient: CodexAppServerClient = {
    modelList: async () => {
      return {data: [], nextCursor: null}
    },
    runJsonTurn: async () => {
      return {text: 'replacement response', usage: null}
    },
  }

  try {
    setCodexAppServerSingletonForTests(oldClient)
    const successPromise = oldClient.runJsonTurn({
      model: 'gpt-5.4',
      inputText: 'success request',
      outputSchema: {type: 'object'},
    })
    const failedPromise = oldClient
      .runJsonTurn({model: 'gpt-5.4', inputText: 'failed request', outputSchema: {type: 'object'}})
      .then(
        () => {
          return null
        },
        (error: unknown) => {
          return error
        },
      )

    await turnsStarted
    sendCompletedTurn('failed request', 'failed')
    const failedResult = await failedPromise
    setCodexAppServerSingletonForTests(replacementClient)
    sendCompletedTurn('success request', 'completed')
    const successResult = await successPromise

    expect(failedResult).toBeInstanceOf(Error)
    expect(failedResult instanceof Error ? failedResult.message : '').toBe('codex app-server: turn failed')
    expect(successResult.text).toBe('success request response')
    expect(killCount).toBe(1)
    expect(getCodexAppServerSingletonForTests()).toBe(replacementClient)
  } finally {
    setCodexAppServerSingletonForTests(null)
  }
})

test('runJsonTurn recycles the app-server after a failed turn', async () => {
  const {client, getKillCount} = createMockConcurrentCodexClient({
    expectedTurnCount: 1,
    notifications: [{inputText: 'failed request', kind: 'complete', status: 'failed'}],
    threadReadTextByInputText: {'failed request': ''},
  })
  const result = await client
    .runJsonTurn({model: 'gpt-5.4', inputText: 'failed request', outputSchema: {type: 'object'}})
    .then(
      () => {
        return null
      },
      (error: unknown) => {
        return error
      },
    )

  expect(result).toBeInstanceOf(Error)
  expect(result instanceof Error ? result.message : '').toBe('codex app-server: turn failed')
  expect(getKillCount()).toBe(1)
})

test('runJsonTurn recycles the app-server after a turn timeout', async () => {
  const {client, getKillCount} = createMockConcurrentCodexClient({
    expectedTurnCount: 1,
    notifications: [],
    threadReadTextByInputText: {},
  })
  const result = await client
    .runJsonTurn({model: 'gpt-5.4', inputText: 'timeout request', outputSchema: {type: 'object'}, timeoutMs: 1})
    .then(
      () => {
        return null
      },
      (error: unknown) => {
        return error
      },
    )

  expect(result).toBeInstanceOf(Error)
  expect(result instanceof Error ? result.message : '').toBe('codex app-server: turn timeout')
  expect(getKillCount()).toBe(1)
})

test('runJsonTurn recycles after max completed turns only once active turns drain', async () => {
  const {client, getKillCount} = createMockConcurrentCodexClient({
    expectedTurnCount: 2,
    maxTurnsBeforeRecycle: 1,
    notifications: [
      {inputText: 'first request', kind: 'complete', status: 'completed'},
      {inputText: 'second request', kind: 'complete', status: 'completed'},
    ],
    threadReadTextByInputText: {'first request': 'first response', 'second request': 'second response'},
  })

  const results = await Promise.allSettled([
    client.runJsonTurn({model: 'gpt-5.4', inputText: 'first request', outputSchema: {type: 'object'}}),
    client.runJsonTurn({model: 'gpt-5.4', inputText: 'second request', outputSchema: {type: 'object'}}),
  ])

  expect(getNormalizedResults(results)).toEqual([
    {status: 'fulfilled', text: 'first response'},
    {status: 'fulfilled', text: 'second response'},
  ])
  expect(getKillCount()).toBe(1)
})

test('runJsonTurn ignores failed partial agent text when only the successful turn gets thread-read output', async () => {
  const {client, threadReadInputs} = createMockConcurrentCodexClient({
    notifications: [
      {inputText: 'failed request', kind: 'item', text: 'failed turn partial'},
      {inputText: 'failed request', kind: 'complete', status: 'failed'},
      {inputText: 'success request', kind: 'complete', status: 'completed'},
    ],
    threadReadTextByInputText: {'failed request': 'failed turn partial', 'success request': 'success thread-read text'},
  })

  const results = await Promise.allSettled([
    client.runJsonTurn({model: 'gpt-5.4', inputText: 'success request', outputSchema: {type: 'object'}}),
    client.runJsonTurn({model: 'gpt-5.4', inputText: 'failed request', outputSchema: {type: 'object'}}),
  ])

  expect(getNormalizedResults(results)).toEqual([
    {status: 'fulfilled', text: 'success thread-read text'},
    {status: 'rejected', reason: 'codex app-server: turn failed'},
  ])
  expect(threadReadInputs).toEqual(['success request'])
})

test('runJsonTurn retries delayed thread reads after a completed turn', async () => {
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const proc = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter
    stdin: {write: (data: string) => boolean}
    stdout: EventEmitter
  }
  let threadReadCount = 0

  const send = (message: unknown) => {
    stdout.emit('data', Buffer.from(`${JSON.stringify(message)}\n`))
  }

  proc.stdout = stdout
  proc.stderr = stderr
  proc.stdin = {
    write(payload) {
      String(payload)
        .split('\n')
        .map((line) => {
          return line.trim()
        })
        .filter((line) => {
          return line.length > 0
        })
        .forEach((line) => {
          const message = JSON.parse(line) as MockJsonRpcRequest

          if (message.method === 'initialize') {
            send({id: message.id, result: {}})
            return
          }

          if (message.method === 'thread/start') {
            send({id: message.id, result: {thread: {id: 'thread-delayed-read'}}})
            return
          }

          if (message.method === 'turn/start') {
            send({id: message.id, result: {turn: {id: 'turn-delayed-read'}}})
            setTimeout(() => {
              send({method: 'turn/completed', params: {turn: {id: 'turn-delayed-read', status: 'completed'}}})
            }, 0)
            return
          }

          if (message.method === 'thread/read') {
            threadReadCount += 1

            if (threadReadCount === 1) {
              return
            }

            send({
              id: message.id,
              result: {
                thread: {
                  turns: [{id: 'turn-delayed-read', items: [{type: 'agentMessage', text: 'delayed thread read text'}]}],
                },
              },
            })
          }
        })

      return true
    },
  }

  const spawnProcess: SpawnCodexAppServer = () => {
    return proc
  }
  const client = createCodexAppServerClient({
    spawnProcess,
    threadReadMaxAttempts: 2,
    threadReadRetryDelayMs: 1,
    threadReadTimeoutMs: 1,
  })
  const result = await client.runJsonTurn({
    model: 'gpt-5.4',
    inputText: 'delayed read request',
    outputSchema: {type: 'object'},
    timeoutMs: 10_000,
  })

  expect(result.text).toBe('delayed thread read text')
  expect(threadReadCount).toBe(2)
})

test('runJsonTurn preserves failed turn error detail', async () => {
  const {client} = createMockConcurrentCodexClient({
    notifications: [
      {
        error: {message: 'Unable to connect. Is the computer able to access the url?'},
        inputText: 'failed request',
        kind: 'complete',
        status: 'failed',
      },
      {inputText: 'success request', kind: 'complete', status: 'completed'},
    ],
    threadReadTextByInputText: {'failed request': '', 'success request': 'success thread-read text'},
  })

  const results = await Promise.allSettled([
    client.runJsonTurn({model: 'gpt-5.4', inputText: 'success request', outputSchema: {type: 'object'}}),
    client.runJsonTurn({model: 'gpt-5.4', inputText: 'failed request', outputSchema: {type: 'object'}}),
  ])

  expect(getNormalizedResults(results)).toEqual([
    {status: 'fulfilled', text: 'success thread-read text'},
    {
      status: 'rejected',
      reason: 'codex app-server: turn failed: Unable to connect. Is the computer able to access the url?',
    },
  ])
})

test('runJsonTurn rejects active turns when app-server exits', async () => {
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const proc = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter
    stdin: {write: (data: string) => boolean}
    stdout: EventEmitter
  }

  const send = (message: unknown) => {
    stdout.emit('data', Buffer.from(`${JSON.stringify(message)}\n`))
  }

  proc.stdout = stdout
  proc.stderr = stderr
  proc.stdin = {
    write(payload) {
      String(payload)
        .split('\n')
        .map((line) => {
          return line.trim()
        })
        .filter((line) => {
          return line.length > 0
        })
        .forEach((line) => {
          const message = JSON.parse(line) as MockJsonRpcRequest

          if (message.method === 'initialize') {
            send({id: message.id, result: {}})
            return
          }

          if (message.method === 'thread/start') {
            send({id: message.id, result: {thread: {id: 'thread-exits'}}})
            return
          }

          if (message.method === 'turn/start') {
            send({id: message.id, result: {turn: {id: 'turn-exits'}}})
            setTimeout(() => {
              proc.emit('exit', 133, null)
            }, 0)
          }
        })

      return true
    },
  }
  const spawnProcess: SpawnCodexAppServer = () => {
    return proc
  }
  const client = createCodexAppServerClient({spawnProcess})
  const result = await client
    .runJsonTurn({model: 'gpt-5.4', inputText: 'active request', outputSchema: {type: 'object'}, timeoutMs: 10_000})
    .then(
      () => {
        return null
      },
      (error: unknown) => {
        return error
      },
    )

  expect(result).toBeInstanceOf(Error)
  expect(result instanceof Error ? result.message : '').toContain('codex app-server exited')
  expect(result instanceof Error ? result.message : '').toContain('code=133')
})
