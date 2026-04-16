import {expect, test} from 'bun:test'

import {getCodexThreadTokenUsageUpdate, getCodexTurnAgentMessageText} from './getCodexAppServerClient.ts'

const getLastJsonLine = (value: string) => {
  const lines = value
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      return line.trim()
    })
    .filter((line) => {
      return line.startsWith('{') && line.endsWith('}')
    })

  const [lastLine = ''] = lines.slice(-1)

  if (lastLine === '') {
    throw new Error(`Expected JSON output but received: ${value}`)
  }

  return lastLine
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

test('runJsonTurn keeps concurrent success scoped when another turn fails out of order', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {EventEmitter} = await import('node:events')
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').pathname
        }

        const clientModulePath = getModulePath('./src/server/utils/getCodexAppServerClient.ts')
        let threadCount = 0
        let turnCount = 0
        let notificationsScheduled = false
        const turnsByThreadId = new Map()
        const threadIdByInputText = new Map()
        const turnIdByInputText = new Map()

        const stdout = new EventEmitter()
        const stderr = new EventEmitter()
        const proc = new EventEmitter()

        const send = (message) => {
          stdout.emit('data', Buffer.from(JSON.stringify(message) + '\\n'))
        }

        const maybeScheduleNotifications = () => {
          if (notificationsScheduled || turnsByThreadId.size !== 2) {
            return
          }

          const startedTurns = Array.from(turnsByThreadId.values())
          if (startedTurns.some((turnId) => typeof turnId !== 'string')) {
            return
          }

          notificationsScheduled = true

          setTimeout(() => {
            send({method: 'item/completed', params: {item: {type: 'agentMessage', text: 'success turn text'}}})
            send({method: 'item/completed', params: {item: {type: 'agentMessage', text: 'failed turn partial'}}})
            send({
              method: 'turn/completed',
              params: {turn: {id: turnIdByInputText.get('failed request'), status: 'failed'}},
            })
            send({
              method: 'turn/completed',
              params: {turn: {id: turnIdByInputText.get('success request'), status: 'completed'}},
            })
          }, 0)
        }

        proc.stdout = stdout
        proc.stderr = stderr
        proc.stdin = {
          write(payload) {
            String(payload)
              .split('\\n')
              .map((line) => {
                return line.trim()
              })
              .filter((line) => {
                return line.length > 0
              })
              .forEach((line) => {
                const message = JSON.parse(line)

                if (message.method === 'initialize') {
                  send({id: message.id, result: {}})
                  return
                }

                if (message.method === 'thread/start') {
                  threadCount += 1
                  const threadId = 'thread-' + threadCount
                  threadIdByInputText.set(message.params.model === 'gpt-5.4' ? 'pending-' + threadId : threadId, threadId)
                  turnsByThreadId.set(threadId, null)
                  send({id: message.id, result: {thread: {id: threadId}}})
                  return
                }

                if (message.method === 'turn/start') {
                  turnCount += 1
                  const turnId = 'turn-' + turnCount
                  const inputText = message.params.input?.[0]?.text
                  turnsByThreadId.set(message.params.threadId, turnId)
                  if (typeof inputText === 'string') {
                    threadIdByInputText.set(inputText, message.params.threadId)
                    turnIdByInputText.set(inputText, turnId)
                  }
                  send({id: message.id, result: {turn: {id: turnId}}})
                  maybeScheduleNotifications()
                  return
                }

                if (message.method === 'thread/read') {
                  const turnId = turnsByThreadId.get(message.params.threadId)
                  const text = message.params.threadId === threadIdByInputText.get('success request')
                    ? 'success turn text'
                    : 'failed turn partial'
                  send({
                    id: message.id,
                    result: {
                      thread: {
                        turns: [{id: turnId, items: [{type: 'agentMessage', text}]}],
                      },
                    },
                  })
                }
              })

            return true
          },
        }

        void mock.module('node:child_process', () => {
          return {spawn: () => proc}
        })

        const {getCodexAppServerClient} = await import(clientModulePath + '?concurrency=' + Date.now())
        const client = getCodexAppServerClient()
        const results = await Promise.allSettled([
          client.runJsonTurn({model: 'gpt-5.4', inputText: 'success request', outputSchema: {type: 'object'}}),
          client.runJsonTurn({model: 'gpt-5.4', inputText: 'failed request', outputSchema: {type: 'object'}}),
        ])

        console.log(
          JSON.stringify({
            turnIds: Object.fromEntries(turnIdByInputText.entries()),
            results: results.map((result) => {
              return result.status === 'fulfilled'
                ? {status: 'fulfilled', text: result.value.text}
                : {status: 'rejected', reason: String(result.reason?.message ?? result.reason)}
            }),
          }),
        )
        process.exit(0)
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(runScript.stderr.toString() || runScript.stdout.toString() || 'Codex concurrency test failed')
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    results: Array<{reason?: string; status: 'fulfilled' | 'rejected'; text?: string}>
  }

  expect(result.results).toEqual([
    {status: 'fulfilled', text: 'success turn text'},
    {status: 'rejected', reason: 'codex app-server: turn failed'},
  ])
})
