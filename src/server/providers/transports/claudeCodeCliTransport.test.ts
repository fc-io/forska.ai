import {chmod, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {afterAll, beforeAll, describe, expect, test} from 'bun:test'

import {classifyConnectionFailure} from '../../cron/judgmentsJobs/connectionHealth.ts'
import {
  classifyJudgmentJobProviderFailure,
  parseProviderRetryAfterAt,
} from '../../services/judgmentJobProviderHealthService.ts'
import {ProviderInvocationError} from '../providerTypes.ts'
import {
  getClaudeCodeChildEnv,
  getClaudeCodeCliArgs,
  getClaudeCodeCliRuntime,
  getClaudeCodeCliStatus,
  getClaudeCodeUsageLimitResetHint,
  invokeClaudeCodeCliModel,
  listClaudeCodeModels,
} from './claudeCodeCliTransport.ts'

const fakeClaudeSource = `#!/usr/bin/env bun
const fs = require('node:fs')
const scenario = process.env.FAKE_CLAUDE_SCENARIO ?? 'success'
const args = process.argv.slice(2)
const stdin = args[0] === '-p' ? fs.readFileSync(0, 'utf8') : ''
const envKeys = Object.keys(process.env).sort()
fs.writeFileSync(process.env.FAKE_CLAUDE_RECORD, JSON.stringify({args, cwd: process.cwd(), env: process.env, envKeys, stdin}))
const usage = {input_tokens: 12, cache_creation_input_tokens: 100, cache_read_input_tokens: 30, output_tokens: 40, output_tokens_details: {thinking_tokens: 8}}
const base = {type: 'result', subtype: 'success', is_error: false, num_turns: 2, duration_ms: 900, duration_api_ms: 800, stop_reason: 'tool_use', session_id: 's', total_cost_usd: 0.001, api_error_status: null, usage}
const print = (value) => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value))
if (args[0] === '--version') { print('2.1.300 (Claude Code)\\n'); process.exit(0) }
if (args[0] === 'auth') {
  print(scenario === 'logged-out' ? {loggedIn: false} : {loggedIn: true, authMethod: 'claude.ai', email: 'me@example.com', subscriptionType: 'max'})
  process.exit(0)
}
if (scenario === 'success') print({...base, result: '{"answer":"yes"}', structured_output: {answer: 'yes'}})
if (scenario === 'structured-only') print({...base, result: '', structured_output: {answer: 'yes'}})
if (scenario === 'not-logged-in') { print({...base, is_error: true, result: 'Not logged in · Please run /login', usage: undefined}); process.exit(1) }
if (scenario === 'usage-limit') { print({...base, is_error: true, api_error_status: 429, result: "You've hit your limit · resets 3pm (Europe/Stockholm)"}); process.exit(1) }
if (scenario === 'overloaded') { print({...base, is_error: true, api_error_status: 529, result: 'API Error: 529 Overloaded'}); process.exit(1) }
if (scenario === 'schema-failure') { print({...base, subtype: 'error_max_structured_output_retries', is_error: true, result: 'not json at all'}); process.exit(1) }
if (scenario === 'non-json') { print('Error: something exploded\\n'); process.exit(2) }
if (scenario === 'hang') { setTimeout(() => print({...base, result: 'late'}), 30000) }
`

const state = {binPath: '', recordPath: '', tempDir: '', workDir: ''}

const getRuntime = (scenario: string, extraEnv: Record<string, string> = {}) => {
  return getClaudeCodeCliRuntime({
    cwd: state.workDir,
    envValues: {
      ANTHROPIC_API_KEY: 'sk-ant-should-not-leak',
      ANTHROPIC_BASE_URL: 'https://proxy.invalid',
      CLAUDECODE: '1',
      CLAUDE_CODE_USE_BEDROCK: '1',
      FAKE_CLAUDE_RECORD: state.recordPath,
      FAKE_CLAUDE_SCENARIO: scenario,
      FORSKA_CLAUDE_CODE_BIN: state.binPath,
      HOME: process.env.HOME,
      KEEP_ME: 'kept',
      PATH: process.env.PATH,
      ...extraEnv,
    },
  })
}

const readRecord = async () => {
  return JSON.parse(await readFile(state.recordPath, 'utf8')) as {
    args: string[]
    cwd: string
    env: Record<string, string>
    envKeys: string[]
    stdin: string
  }
}

const invoke = (scenario: string, options: {extraEnv?: Record<string, string>; signal?: AbortSignal} = {}) => {
  return invokeClaudeCodeCliModel({
    effort: 'low',
    modelName: 'claude-haiku-5-5',
    outputSchema: {additionalProperties: false, properties: {answer: {type: 'string'}}, type: 'object'},
    prompt: 'long article prompt',
    runtime: getRuntime(scenario, options.extraEnv),
    signal: options.signal,
    systemPrompt: 'You are a judge.',
  })
}

const getRejection = async (promise: Promise<unknown>): Promise<unknown> => {
  return promise.then(
    () => {
      return null
    },
    (error: unknown) => {
      return error
    },
  )
}

beforeAll(async () => {
  state.tempDir = await mkdtemp(path.join(os.tmpdir(), 'forska-claude-code-test-'))
  state.binPath = path.join(state.tempDir, 'claude')
  state.recordPath = path.join(state.tempDir, 'record.json')
  state.workDir = path.join(state.tempDir, 'claude-code-cwd', 'api')
  await writeFile(state.binPath, fakeClaudeSource)
  await chmod(state.binPath, 0o755)
})

afterAll(async () => {
  await rm(state.tempDir, {force: true, recursive: true})
})

describe('getClaudeCodeCliArgs', () => {
  test('builds the exact isolated print-mode argv', () => {
    expect(
      getClaudeCodeCliArgs({
        effort: 'high',
        modelName: 'claude-opus-5-5',
        outputSchema: {type: 'object'},
        systemPrompt: 'system',
      }),
    ).toEqual([
      '-p',
      '--system-prompt',
      'system',
      '--output-format',
      'json',
      '--json-schema',
      '{"type":"object"}',
      '--model',
      'claude-opus-5-5',
      '--effort',
      'high',
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
    ])
  })

  test('omits --json-schema and --effort when absent', () => {
    const args = getClaudeCodeCliArgs({
      effort: null,
      modelName: 'claude-opus-5-5',
      outputSchema: null,
      systemPrompt: '',
    })

    expect(args).not.toContain('--json-schema')
    expect(args).not.toContain('--effort')
    expect(args).not.toContain('--bare')
  })
})

describe('getClaudeCodeChildEnv', () => {
  test('strips API-key, provider-routing, and parent-session variables', () => {
    const env = getClaudeCodeChildEnv({
      ANTHROPIC_API_KEY: 'x',
      ANTHROPIC_AUTH_TOKEN: 'x',
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_USE_FOUNDRY: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      KEEP_ME: 'kept',
      MAX_THINKING_TOKENS: '1',
    })

    expect(env).toEqual({DISABLE_AUTOUPDATER: '1', KEEP_ME: 'kept'})
  })
})

describe('invokeClaudeCodeCliModel', () => {
  test('returns result text, structured output, and usage including cached prompt tokens', async () => {
    const result = await invoke('success')
    const record = await readRecord()

    expect(result).toEqual({
      stopReason: 'tool_use',
      structuredOutput: {answer: 'yes'},
      text: '{"answer":"yes"}',
      usage: {completionTokens: 40, promptTokens: 142, totalTokens: 182},
    })
    expect(record.stdin).toBe('long article prompt')
    expect(record.args).toEqual(
      getClaudeCodeCliArgs({
        effort: 'low',
        modelName: 'claude-haiku-5-5',
        outputSchema: {additionalProperties: false, properties: {answer: {type: 'string'}}, type: 'object'},
        systemPrompt: 'You are a judge.',
      }),
    )
    expect(record.cwd).toBe(await realpath(state.workDir))
    expect(record.env.KEEP_ME).toBe('kept')
    expect(record.env.DISABLE_AUTOUPDATER).toBe('1')
    expect(record.envKeys).not.toContain('ANTHROPIC_API_KEY')
    expect(record.envKeys).not.toContain('ANTHROPIC_BASE_URL')
    expect(record.envKeys).not.toContain('CLAUDECODE')
    expect(record.envKeys).not.toContain('CLAUDE_CODE_USE_BEDROCK')
  })

  test('falls back to structured_output when result text is empty', async () => {
    const result = await invoke('structured-only')

    expect(result.text).toBe('{"answer":"yes"}')
  })

  test('maps "Not logged in" to a non-recoverable auth failure with the login instruction', async () => {
    const error = await getRejection(invoke('not-logged-in'))

    expect(error).toBeInstanceOf(ProviderInvocationError)
    expect(error).toMatchObject({code: 'claude_code_not_logged_in', providerKind: 'claude-code'})
    expect((error as Error).message).toContain('/login')
    expect(classifyJudgmentJobProviderFailure({message: (error as Error).message})).toBe('auth')
  })

  test('maps a 429 usage limit to a recoverable usage_limit failure with a parseable reset time', async () => {
    const error = await getRejection(invoke('usage-limit'))
    const message = (error as Error).message

    expect(error).toMatchObject({code: 'claude_code_usage_limit', providerKind: 'claude-code'})
    expect(message).toContain('usage limit')
    expect(message).toContain('resets at 3:00 pm')
    expect(classifyJudgmentJobProviderFailure({message})).toBe('usage_limit')
    expect(parseProviderRetryAfterAt(message, new Date(2026, 9, 16, 12, 0, 0))).toEqual(new Date(2026, 9, 16, 15, 0, 0))
    expect(
      classifyConnectionFailure({
        context: {effectiveBaseURL: 'claude-code://cli', endpointPath: null, providerKind: 'claude-code'},
        error,
      }).shouldPauseConnection,
    ).toBe(false)
    expect((error as ProviderInvocationError).usage).toEqual({
      completionTokens: 40,
      promptTokens: 142,
      totalTokens: 182,
    })
  })

  test('maps 529 overloaded to a recoverable transient failure', async () => {
    const error = await getRejection(invoke('overloaded'))

    expect(error).toMatchObject({code: 'claude_code_transient_failure'})
    expect((error as Error).message).toContain('status 529')
  })

  test('maps structured-output failures to a non-recoverable request failure with the raw text', async () => {
    const error = await getRejection(invoke('schema-failure'))

    expect(error).toMatchObject({code: 'claude_code_request_failed'})
    expect((error as Error).message).toContain('not json at all')
  })

  test('maps non-JSON stdout to an invalid-output failure', async () => {
    const error = await getRejection(invoke('non-json'))

    expect(error).toMatchObject({code: 'claude_code_invalid_output'})
    expect((error as Error).message).toContain('exit code 2')
    expect((error as Error).message).toContain('something exploded')
  })

  test('kills the child and fails as transient when the request times out', async () => {
    const startedAt = Date.now()
    const error = await getRejection(invoke('hang', {extraEnv: {FORSKA_CLAUDE_CODE_REQUEST_TIMEOUT_MS: '300'}}))

    expect(error).toMatchObject({code: 'claude_code_transient_failure'})
    expect((error as Error).message).toContain('timed out after 300 ms')
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    expect(
      classifyConnectionFailure({
        context: {effectiveBaseURL: 'claude-code://cli', endpointPath: null, providerKind: 'claude-code'},
        error,
      }).kind,
    ).toBe('other')
  })

  test('rejects with the abort reason when the admission signal aborts', async () => {
    const controller = new AbortController()
    const reason = new Error('lease lost')
    const pending = getRejection(invoke('hang', {signal: controller.signal}))

    setTimeout(() => {
      controller.abort(reason)
    }, 100)

    expect(await pending).toBe(reason)
  })

  test('reports a missing binary as cli unavailable', async () => {
    const error = await getRejection(
      invoke('success', {extraEnv: {FORSKA_CLAUDE_CODE_BIN: path.join(state.tempDir, 'missing-claude')}}),
    )

    expect(error).toMatchObject({code: 'claude_code_cli_unavailable'})
  })
})

describe('getClaudeCodeCliStatus', () => {
  test('reports version, account, and plan when logged in', async () => {
    const status = await getClaudeCodeCliStatus({runtime: getRuntime('success')})

    expect(status).toMatchObject({
      authMethod: 'claude.ai',
      cliAvailable: true,
      email: 'me@example.com',
      loggedIn: true,
      subscriptionType: 'max',
      version: '2.1.300',
    })
    expect(status.message).toBe('Claude Code 2.1.300 logged in as me@example.com (max).')
  })

  test('returns the login instruction when logged out', async () => {
    const status = await getClaudeCodeCliStatus({runtime: getRuntime('logged-out')})

    expect(status.loggedIn).toBe(false)
    expect(status.message).toContain('/login')
  })

  test('reports an unavailable CLI', async () => {
    const status = await getClaudeCodeCliStatus({
      runtime: getRuntime('success', {FORSKA_CLAUDE_CODE_BIN: path.join(state.tempDir, 'missing-claude')}),
    })

    expect(status.cliAvailable).toBe(false)
    expect(status.message).toContain('FORSKA_CLAUDE_CODE_BIN')
  })
})

describe('listClaudeCodeModels', () => {
  test('lists every model and effort, enabling only Opus and Sonnet at high effort by default', () => {
    const models = listClaudeCodeModels()

    expect(models).toHaveLength(15)
    expect(
      models
        .filter((model) => {
          return model.defaultEnabled
        })
        .map((model) => {
          return model.displayName
        }),
    ).toEqual(['Claude Opus 5.5 (effort: high)', 'Claude Sonnet 5.5 (effort: high)'])
    expect(models[0]).toMatchObject({
      modelName: 'claude-opus-5-5',
      remoteModelId: 'claude-opus-5-5',
      variant: 'low',
      version: 'low',
    })
  })
})

describe('getClaudeCodeUsageLimitResetHint', () => {
  test('converts epoch and clock reset formats into "resets at" phrases', () => {
    expect(getClaudeCodeUsageLimitResetHint('Claude AI usage limit reached|1760620800')).toBe(
      'resets at 2025-10-16T13:20:00.000Z',
    )
    expect(getClaudeCodeUsageLimitResetHint('5-hour limit reached ∙ resets 4:30pm')).toBe('resets at 4:30 pm')
    expect(getClaudeCodeUsageLimitResetHint('rate limited')).toBeNull()
  })
})
