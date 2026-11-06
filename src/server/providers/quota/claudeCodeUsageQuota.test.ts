import {describe, expect, test} from 'bun:test'

import {
  claudeCodeCredentialsKeychainService,
  claudeCodeUsageEndpoint,
  fetchClaudeCodeUsage,
  getRetryAfterMs,
  parseClaudeCodeUsageReadings,
  readClaudeCodeAccessToken,
  type RunKeychainCommand,
} from './claudeCodeUsageQuota.ts'

const capturedUsageResponseText =
  '{"five_hour":null,"seven_day":{"utilization":0.0,"resets_at":"2026-11-13T20:00:00.750521+00:00","limit_dollars":null,"used_dollars":null,"remaining_dollars":null,"locked_reason":null},"seven_day_oauth_apps":null,"seven_day_opus":null,"seven_day_sonnet":null,"limits":[{"kind":"weekly_all","group":"weekly","percent":0,"severity":"normal","resets_at":"2026-11-13T20:00:00.750521+00:00","scope":null,"is_active":true},{"kind":"weekly_scoped","group":"weekly","percent":0,"severity":"normal","resets_at":"2026-11-13T20:00:00+00:00","scope":{"model":{"id":null,"display_name":"Fable"},"surface":null},"is_active":false}],"seven_day_breakdown":null}'

const capturedUsageResponse = JSON.parse(capturedUsageResponseText) as {
  limits: Record<string, unknown>[]
  seven_day: Record<string, unknown>
}

const context = {observedAt: new Date('2026-11-06T12:00:00.000Z'), providerConnectionId: 'connection-claude'}
const secretToken = 'sk-ant-oat01-secret-token-value'
const credentialsJson = JSON.stringify({claudeAiOauth: {accessToken: secretToken}})

const createRunCommand = (
  result: Awaited<ReturnType<RunKeychainCommand>>,
): {calls: Array<{args: string[]; timeoutMs: number}>; runCommand: RunKeychainCommand} => {
  const calls: Array<{args: string[]; timeoutMs: number}> = []
  const runCommand: RunKeychainCommand = async (args, timeoutMs) => {
    calls.push({args, timeoutMs})
    return result
  }

  return {calls, runCommand}
}

const readMissingReason = async (options: Parameters<typeof readClaudeCodeAccessToken>[0]): Promise<string> => {
  const result = await readClaudeCodeAccessToken(options)

  expect(result.kind).toBe('missing')

  return result.kind === 'missing' ? result.reason : ''
}

const createFetchUsage = (response: Response | Error) => {
  const calls: Array<{init: RequestInit; url: string}> = []
  const fetchUsage = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({init, url})

    if (response instanceof Error) {
      throw response
    }

    return response
  }

  return {calls, fetchUsage}
}

describe('parseClaudeCodeUsageReadings', () => {
  test('parses the captured usage response into seven_day, weekly_all and weekly_scoped:Fable rows', () => {
    const readings = parseClaudeCodeUsageReadings(capturedUsageResponse, context)

    expect(readings).toHaveLength(3)
    expect(
      readings.map((reading) => {
        return reading.limitKind
      }),
    ).toEqual(['seven_day', 'weekly_all', 'weekly_scoped:Fable'])
    expect(readings[0]).toEqual({
      isActive: null,
      limitKind: 'seven_day',
      observedAt: context.observedAt,
      providerConnectionId: 'connection-claude',
      providerKind: 'claude-code',
      rawJson: {seven_day: capturedUsageResponse.seven_day, seven_day_breakdown: null},
      resetsAt: new Date('2026-11-13T20:00:00.750Z'),
      scopeJson: null,
      utilizationPercent: 0,
    })
    expect(readings[1]).toEqual({
      isActive: true,
      limitKind: 'weekly_all',
      observedAt: context.observedAt,
      providerConnectionId: 'connection-claude',
      providerKind: 'claude-code',
      rawJson: capturedUsageResponse.limits[0],
      resetsAt: new Date('2026-11-13T20:00:00.750Z'),
      scopeJson: {group: 'weekly', scope: null, severity: 'normal'},
      utilizationPercent: 0,
    })
    expect(readings[2]).toEqual({
      isActive: false,
      limitKind: 'weekly_scoped:Fable',
      observedAt: context.observedAt,
      providerConnectionId: 'connection-claude',
      providerKind: 'claude-code',
      rawJson: capturedUsageResponse.limits[1],
      resetsAt: new Date('2026-11-13T20:00:00.000Z'),
      scopeJson: {
        group: 'weekly',
        scope: {model: {id: null, display_name: 'Fable'}, surface: null},
        severity: 'normal',
      },
      utilizationPercent: 0,
    })
  })

  test('adds a five_hour row when five_hour is an object with a numeric utilization', () => {
    const readings = parseClaudeCodeUsageReadings(
      {...capturedUsageResponse, five_hour: {resets_at: '2026-11-06T15:00:00+00:00', utilization: 12.5}},
      context,
    )
    const fiveHour = readings.find((reading) => {
      return reading.limitKind === 'five_hour'
    })

    expect(readings).toHaveLength(4)
    expect(fiveHour).toEqual({
      isActive: null,
      limitKind: 'five_hour',
      observedAt: context.observedAt,
      providerConnectionId: 'connection-claude',
      providerKind: 'claude-code',
      rawJson: {five_hour: {resets_at: '2026-11-06T15:00:00+00:00', utilization: 12.5}},
      resetsAt: new Date('2026-11-06T15:00:00.000Z'),
      scopeJson: null,
      utilizationPercent: 12.5,
    })
  })

  test('returns no rows for a body that is not an object', () => {
    expect(parseClaudeCodeUsageReadings(null, context)).toEqual([])
    expect(parseClaudeCodeUsageReadings('usage', context)).toEqual([])
    expect(parseClaudeCodeUsageReadings(42, context)).toEqual([])
    expect(parseClaudeCodeUsageReadings([capturedUsageResponse], context)).toEqual([])
  })

  test('skips a limits entry without a numeric percent', () => {
    const readings = parseClaudeCodeUsageReadings(
      {
        limits: [
          {is_active: true, kind: 'weekly_all', percent: '34', scope: null},
          {is_active: true, kind: 'weekly_all', scope: null},
          {is_active: true, kind: 'weekly_all', percent: 34, scope: null},
        ],
      },
      context,
    )

    expect(readings).toHaveLength(1)
    expect(readings[0]?.utilizationPercent).toBe(34)
  })
})

describe('readClaudeCodeAccessToken', () => {
  test('returns the access token from the keychain credentials JSON', async () => {
    const {calls, runCommand} = createRunCommand({
      exitCode: 0,
      stdout: `${JSON.stringify({claudeAiOauth: {accessToken: 'tok'}})}\n`,
      timedOut: false,
    })

    expect(await readClaudeCodeAccessToken({env: {}, platform: 'darwin', runCommand})).toEqual({
      kind: 'ok',
      token: 'tok',
    })
    expect(calls).toEqual([
      {args: ['find-generic-password', '-s', claudeCodeCredentialsKeychainService, '-w'], timeoutMs: 5_000},
    ])
  })

  test('is missing on a platform other than darwin without running the keychain command', async () => {
    const {calls, runCommand} = createRunCommand({exitCode: 0, stdout: credentialsJson, timedOut: false})
    const reason = await readMissingReason({env: {}, platform: 'linux', runCommand})

    expect(reason).toContain('linux')
    expect(calls).toHaveLength(0)
  })

  test('is missing when CLAUDE_CONFIG_DIR is set without running the keychain command', async () => {
    const {calls, runCommand} = createRunCommand({exitCode: 0, stdout: credentialsJson, timedOut: false})
    const reason = await readMissingReason({
      env: {CLAUDE_CONFIG_DIR: '/tmp/claude-alt'},
      platform: 'darwin',
      runCommand,
    })

    expect(reason).toContain('CLAUDE_CONFIG_DIR')
    expect(calls).toHaveLength(0)
  })

  test('is missing on a non-zero exit even when stdout holds a token', async () => {
    const {runCommand} = createRunCommand({exitCode: 44, stdout: credentialsJson, timedOut: false})
    const reason = await readMissingReason({env: {}, platform: 'darwin', runCommand})

    expect(reason).toContain('exit 44')
    expect(reason).not.toContain(secretToken)
  })

  test('is missing with a timed out reason when the keychain read times out', async () => {
    const {runCommand} = createRunCommand({exitCode: null, stdout: credentialsJson, timedOut: true})
    const reason = await readMissingReason({env: {}, platform: 'darwin', runCommand})

    expect(reason).toContain('timed out')
    expect(reason).not.toContain(secretToken)
  })

  test('is missing when the credentials JSON has no accessToken', async () => {
    const {runCommand} = createRunCommand({
      exitCode: 0,
      stdout: JSON.stringify({claudeAiOauth: {refreshToken: secretToken}}),
      timedOut: false,
    })
    const reason = await readMissingReason({env: {}, platform: 'darwin', runCommand})

    expect(reason).toBe('keychain entry has no claudeAiOauth.accessToken')
    expect(reason).not.toContain(secretToken)
  })

  test('is missing when stdout is not JSON', async () => {
    const {runCommand} = createRunCommand({exitCode: 0, stdout: secretToken, timedOut: false})
    const reason = await readMissingReason({env: {}, platform: 'darwin', runCommand})

    expect(reason).not.toContain(secretToken)
  })

  test('is missing without throwing when the keychain command rejects', async () => {
    const runCommand: RunKeychainCommand = async () => {
      throw new Error(`security failed for ${secretToken}`)
    }
    const reason = await readMissingReason({env: {}, platform: 'darwin', runCommand})

    expect(reason).toContain('not readable')
    expect(reason).not.toContain(secretToken)
  })
})

describe('fetchClaudeCodeUsage', () => {
  test('returns the JSON body on 200 and sends the OAuth usage request headers', async () => {
    const {calls, fetchUsage} = createFetchUsage(Response.json(capturedUsageResponse, {status: 200}))

    expect(await fetchClaudeCodeUsage({accessToken: 'tok', fetchUsage})).toEqual({
      body: capturedUsageResponse,
      kind: 'ok',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(claudeCodeUsageEndpoint)
    expect(calls[0]?.init.headers).toEqual({
      'anthropic-beta': 'oauth-2025-04-20',
      Authorization: 'Bearer tok',
      'User-Agent': 'claude-cli/2.0',
    })
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal)
  })

  test('returns auth on 401', async () => {
    const {fetchUsage} = createFetchUsage(new Response('unauthorized', {status: 401}))

    expect(await fetchClaudeCodeUsage({accessToken: 'tok', fetchUsage})).toEqual({
      kind: 'auth',
      reason: 'usage endpoint returned 401',
    })
  })

  test('returns auth on 403', async () => {
    const {fetchUsage} = createFetchUsage(new Response('forbidden', {status: 403}))

    expect(await fetchClaudeCodeUsage({accessToken: 'tok', fetchUsage})).toEqual({
      kind: 'auth',
      reason: 'usage endpoint returned 403',
    })
  })

  test('returns transient with the retry-after delay on 429', async () => {
    const {fetchUsage} = createFetchUsage(new Response('slow down', {headers: {'retry-after': '120'}, status: 429}))

    expect(await fetchClaudeCodeUsage({accessToken: 'tok', fetchUsage})).toEqual({
      kind: 'transient',
      reason: 'usage endpoint returned 429',
      retryAfterMs: 120_000,
    })
  })

  test('returns transient without a retry-after delay on 503 without the header', async () => {
    const {fetchUsage} = createFetchUsage(new Response('unavailable', {status: 503}))

    expect(await fetchClaudeCodeUsage({accessToken: 'tok', fetchUsage})).toEqual({
      kind: 'transient',
      reason: 'usage endpoint returned 503',
      retryAfterMs: null,
    })
  })

  test('returns transient when fetch throws', async () => {
    const {fetchUsage} = createFetchUsage(new Error('socket hang up'))

    expect(await fetchClaudeCodeUsage({accessToken: 'tok', fetchUsage})).toEqual({
      kind: 'transient',
      reason: 'socket hang up',
      retryAfterMs: null,
    })
  })
})

describe('getRetryAfterMs', () => {
  test('converts seconds to milliseconds at the boundaries', () => {
    expect(getRetryAfterMs('0')).toBe(0)
    expect(getRetryAfterMs('1')).toBe(1_000)
    expect(getRetryAfterMs('120')).toBe(120_000)
  })

  test('returns null for missing, blank, negative and non-numeric values', () => {
    expect(getRetryAfterMs(null)).toBeNull()
    expect(getRetryAfterMs('')).toBeNull()
    expect(getRetryAfterMs('   ')).toBeNull()
    expect(getRetryAfterMs('-1')).toBeNull()
    expect(getRetryAfterMs('abc')).toBeNull()
  })
})
