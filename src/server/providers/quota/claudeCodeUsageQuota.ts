import type {ProviderQuotaReadingInsert} from '../../services/providerQuotaReadingService.ts'

export const claudeCodeUsageEndpoint = 'https://api.anthropic.com/api/oauth/usage'
export const claudeCodeCredentialsKeychainService = 'Claude Code-credentials'

const claudeCodeKeychainTimeoutMs = 5_000
const claudeCodeUsageRequestTimeoutMs = 15_000

export type ClaudeCodeAccessTokenResult = {kind: 'missing'; reason: string} | {kind: 'ok'; token: string}

export type ProviderQuotaFetchResult =
  | {body: unknown; kind: 'ok'}
  | {kind: 'auth'; reason: string}
  | {kind: 'transient'; reason: string; retryAfterMs: number | null}

type KeychainCommandResult = {exitCode: number | null; stdout: string; timedOut: boolean}

export type RunKeychainCommand = (args: string[], timeoutMs: number) => Promise<KeychainCommandResult>

type FetchUsage = (url: string, init: RequestInit) => Promise<Response>

type ClaudeReadingContext = {observedAt: Date; providerConnectionId: string}

const readProcessText = async (stream: ReadableStream<Uint8Array> | null): Promise<string> => {
  return stream ? new Response(stream).text() : ''
}

export const runSecurityKeychainCommand: RunKeychainCommand = async (args, timeoutMs) => {
  const child = globalThis.Bun.spawn(['security', ...args], {stderr: 'ignore', stdin: 'ignore', stdout: 'pipe'})
  const state = {timedOut: false}
  const timeout = setTimeout(() => {
    state.timedOut = true
    child.kill()
  }, timeoutMs)
  const [exitCode, stdout] = await Promise.all([child.exited, readProcessText(child.stdout)]).finally(() => {
    clearTimeout(timeout)
  })

  return {exitCode, stdout, timedOut: state.timedOut}
}

const getRecord = (value: unknown): Record<string, unknown> | null => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

const parseJsonOrNull = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

const getAccessTokenFromCredentials = (stdout: string): string | null => {
  const token = getRecord(getRecord(parseJsonOrNull(stdout.trim()))?.claudeAiOauth)?.accessToken

  return typeof token === 'string' && token.trim() !== '' ? token.trim() : null
}

const getAccessTokenResult = (command: KeychainCommandResult): ClaudeCodeAccessTokenResult => {
  const token = command.exitCode === 0 ? getAccessTokenFromCredentials(command.stdout) : null

  return token
    ? {kind: 'ok', token}
    : {
        kind: 'missing',
        reason: command.timedOut
          ? 'keychain read timed out'
          : command.exitCode === 0
            ? 'keychain entry has no claudeAiOauth.accessToken'
            : `keychain entry "${claudeCodeCredentialsKeychainService}" not readable (exit ${String(command.exitCode)})`,
      }
}

export const readClaudeCodeAccessToken = async ({
  env = process.env,
  platform = process.platform,
  runCommand = runSecurityKeychainCommand,
}: {
  env?: Record<string, string | undefined>
  platform?: string
  runCommand?: RunKeychainCommand
} = {}): Promise<ClaudeCodeAccessTokenResult> => {
  if (platform !== 'darwin') {
    return {kind: 'missing', reason: `the Claude CLI keychain is only read on macOS (platform ${platform})`}
  }

  if (env.CLAUDE_CONFIG_DIR) {
    return {kind: 'missing', reason: 'CLAUDE_CONFIG_DIR is set; only the default Claude CLI login is read'}
  }

  return getAccessTokenResult(
    await runCommand(
      ['find-generic-password', '-s', claudeCodeCredentialsKeychainService, '-w'],
      claudeCodeKeychainTimeoutMs,
    ).catch((): KeychainCommandResult => {
      return {exitCode: null, stdout: '', timedOut: false}
    }),
  )
}

export const getRetryAfterMs = (value: string | null): number | null => {
  const seconds = value === null || value.trim() === '' ? Number.NaN : Number(value)

  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null
}

const getHttpFailureResult = (response: Response): ProviderQuotaFetchResult => {
  return response.status === 401 || response.status === 403
    ? {kind: 'auth', reason: `usage endpoint returned ${response.status}`}
    : {
        kind: 'transient',
        reason: `usage endpoint returned ${response.status}`,
        retryAfterMs: getRetryAfterMs(response.headers.get('retry-after')),
      }
}

const getUsageResponseResult = async (response: Response): Promise<ProviderQuotaFetchResult> => {
  return response.ok ? {body: await response.json(), kind: 'ok'} : getHttpFailureResult(response)
}

export const fetchClaudeCodeUsage = async ({
  accessToken,
  fetchUsage = fetch,
}: {
  accessToken: string
  fetchUsage?: FetchUsage
}): Promise<ProviderQuotaFetchResult> => {
  return fetchUsage(claudeCodeUsageEndpoint, {
    headers: {
      'anthropic-beta': 'oauth-2025-04-20',
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'claude-cli/2.0',
    },
    signal: AbortSignal.timeout(claudeCodeUsageRequestTimeoutMs),
  })
    .then(getUsageResponseResult)
    .catch((error: unknown) => {
      return {
        kind: 'transient' as const,
        reason: error instanceof Error ? error.message : String(error),
        retryAfterMs: null,
      }
    })
}

const getDateOrNull = (value: unknown): Date | null => {
  const date = typeof value === 'string' ? new Date(value) : null

  return date && Number.isFinite(date.getTime()) ? date : null
}

const isClaudeUsageWindowKey = (key: string): boolean => {
  return key === 'five_hour' || key === 'seven_day' || (key.startsWith('seven_day_') && key !== 'seven_day_breakdown')
}

const getWindowRawJson = (body: Record<string, unknown>, key: string, window: Record<string, unknown>) => {
  return key === 'seven_day'
    ? {seven_day: window, seven_day_breakdown: body.seven_day_breakdown ?? null}
    : {[key]: window}
}

const getClaudeWindowReadings = (
  body: Record<string, unknown>,
  context: ClaudeReadingContext,
): ProviderQuotaReadingInsert[] => {
  return Object.entries(body).flatMap(([key, value]) => {
    const window = getRecord(value)

    return isClaudeUsageWindowKey(key) && window && typeof window.utilization === 'number'
      ? [
          {
            isActive: null,
            limitKind: key,
            observedAt: context.observedAt,
            providerConnectionId: context.providerConnectionId,
            providerKind: 'claude-code',
            rawJson: getWindowRawJson(body, key, window),
            resetsAt: getDateOrNull(window.resets_at),
            scopeJson: null,
            utilizationPercent: window.utilization,
          },
        ]
      : []
  })
}

const getScopedLimitSuffix = (scope: Record<string, unknown> | null): string => {
  const model = getRecord(scope?.model)
  const name = [model?.id, model?.display_name, scope?.surface].find((value) => {
    return typeof value === 'string' && value.trim() !== ''
  })

  return scope === null ? '' : `:${typeof name === 'string' ? name : 'scoped'}`
}

const getClaudeLimitReading = (
  entry: Record<string, unknown>,
  context: ClaudeReadingContext,
): ProviderQuotaReadingInsert | null => {
  const scope = getRecord(entry.scope)

  return typeof entry.kind === 'string' && typeof entry.percent === 'number'
    ? {
        isActive: typeof entry.is_active === 'boolean' ? entry.is_active : null,
        limitKind: `${entry.kind}${getScopedLimitSuffix(scope)}`,
        observedAt: context.observedAt,
        providerConnectionId: context.providerConnectionId,
        providerKind: 'claude-code',
        rawJson: entry,
        resetsAt: getDateOrNull(entry.resets_at),
        scopeJson: {group: entry.group ?? null, scope: entry.scope ?? null, severity: entry.severity ?? null},
        utilizationPercent: entry.percent,
      }
    : null
}

const getClaudeLimitReadings = (
  body: Record<string, unknown>,
  context: ClaudeReadingContext,
): ProviderQuotaReadingInsert[] => {
  return (Array.isArray(body.limits) ? body.limits : []).flatMap((entry) => {
    const record = getRecord(entry)
    const reading = record ? getClaudeLimitReading(record, context) : null

    return reading ? [reading] : []
  })
}

export const parseClaudeCodeUsageReadings = (
  body: unknown,
  context: ClaudeReadingContext,
): ProviderQuotaReadingInsert[] => {
  const record = getRecord(body)

  return record ? [...getClaudeWindowReadings(record, context), ...getClaudeLimitReadings(record, context)] : []
}
