import {cron} from '@elysiajs/cron'
import {Elysia} from 'elysia'

import {
  type ClaudeCodeAccessTokenResult,
  fetchClaudeCodeUsage,
  parseClaudeCodeUsageReadings,
  type ProviderQuotaFetchResult,
  readClaudeCodeAccessToken,
} from '../providers/quota/claudeCodeUsageQuota.ts'
import {parseCodexRateLimitReadings} from '../providers/quota/codexRateLimitQuota.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {insertProviderQuotaReadings, type ProviderQuotaReadingInsert} from '../services/providerQuotaReadingService.ts'
import {getCodexAppServerClient} from '../utils/getCodexAppServerClient.ts'
import {createRateLimitedLogger} from '../utils/rateLimitedLogger.ts'
import {
  canCurrentServerOwnDuckdb,
  isExpectedDuckdbOwnerRoleLossError,
  shouldCurrentServerRunMaintenanceLoops,
} from '../utils/serverRuntimeRole.ts'
import {
  getNextProviderQuotaPollState,
  initialProviderQuotaPollState,
  isProviderQuotaPollDue,
  providerQuotaPollConstants,
  type ProviderQuotaPollOutcome,
  type ProviderQuotaPollState,
} from './providerQuotaPoll/providerQuotaPollSchedule.ts'

const PROVIDER_QUOTA_POLL_INTERVAL = '*/20 * * * * *'
const START_DELAY_MS = 20_000

export const polledProviderQuotaKinds = ['claude-code', 'codex'] as const

export type PolledProviderQuotaKind = (typeof polledProviderQuotaKinds)[number]

export type ProviderQuotaPollConnection = {
  hasRunningJob: boolean
  providerConnectionId: string
  providerKind: PolledProviderQuotaKind
}

export type ProviderQuotaPollDeps = {
  fetchQuota: Record<PolledProviderQuotaKind, () => Promise<ProviderQuotaFetchResult>>
  insertReadings: (readings: ProviderQuotaReadingInsert[]) => Promise<number>
  now: () => number
  readConnections: () => Promise<ProviderQuotaPollConnection[]>
  shouldRun: () => boolean
}

export type ProviderQuotaPollWakeResult =
  | {reason: 'maintenance-role' | 'not-due' | 'no-connection-due'; status: 'skipped'}
  | {inserted: number; outcomes: Partial<Record<PolledProviderQuotaKind, ProviderQuotaPollOutcome>>; status: 'ran'}

type ProviderQuotaPollKindResult = {
  kind: PolledProviderQuotaKind
  outcome: ProviderQuotaPollOutcome
  readings: ProviderQuotaReadingInsert[]
}

const providerQuotaPollLogger = createRateLimitedLogger({
  sink: 'both',
  windowMs: providerQuotaPollConstants.warnIntervalMs,
})

const providerQuotaReadParsers: Record<
  PolledProviderQuotaKind,
  (body: unknown, context: {observedAt: Date; providerConnectionId: string}) => ProviderQuotaReadingInsert[]
> = {'claude-code': parseClaudeCodeUsageReadings, codex: parseCodexRateLimitReadings}

const pollStates = new Map<PolledProviderQuotaKind, ProviderQuotaPollState>()

const connectionsReadState: {
  connectedKinds: PolledProviderQuotaKind[]
  lastReadAtMs: number | null
  runningJobKinds: PolledProviderQuotaKind[]
} = {connectedKinds: [], lastReadAtMs: null, runningJobKinds: []}

const getPollState = (kind: PolledProviderQuotaKind): ProviderQuotaPollState => {
  return pollStates.get(kind) ?? initialProviderQuotaPollState
}

export const getProviderQuotaPollStateForTests = (kind: PolledProviderQuotaKind): ProviderQuotaPollState => {
  return getPollState(kind)
}

export const resetProviderQuotaPollStateForTests = (): void => {
  pollStates.clear()
  connectionsReadState.connectedKinds = []
  connectionsReadState.lastReadAtMs = null
  connectionsReadState.runningJobKinds = []
}

const providerQuotaConnectionsWorkloadContext = {
  fallbackIntent: 'reject' as const,
  maxResultRows: 200,
  routeOrJobKey: 'providerQuota.poll.connections',
  workloadClass: 'admin.telemetry',
}

export const providerQuotaPollConnectionsSql = `
  SELECT
    pc.id AS providerConnectionId,
    pc.provider_kind AS providerKind,
    bool_or(jj.id IS NOT NULL) AS hasRunningJob
  FROM app.provider_connection pc
  LEFT JOIN app.model m ON m.provider_connection_id = pc.id
  LEFT JOIN app.project p ON p.model_id = m.id AND p.archived = FALSE
  LEFT JOIN app.judgment_job jj ON jj.project_id = p.id AND jj.status = 'running'
  WHERE pc.provider_kind IN ('claude-code', 'codex')
    AND pc.enabled = TRUE
  GROUP BY pc.id, pc.provider_kind
  ORDER BY pc.provider_kind, pc.id
`

const readProviderQuotaPollConnections = async (): Promise<ProviderQuotaPollConnection[]> => {
  return getAppDatabaseService().queryJsonBackground<ProviderQuotaPollConnection>(
    providerQuotaPollConnectionsSql,
    providerQuotaConnectionsWorkloadContext,
  )
}

const getClaudeTokenFetchResult = async (token: ClaudeCodeAccessTokenResult): Promise<ProviderQuotaFetchResult> => {
  return token.kind === 'ok' ? fetchClaudeCodeUsage({accessToken: token.token}) : {kind: 'auth', reason: token.reason}
}

const fetchClaudeCodeQuota = async (): Promise<ProviderQuotaFetchResult> => {
  return getClaudeTokenFetchResult(await readClaudeCodeAccessToken())
}

const codexAuthFailurePattern = /\b401\b|unauthori[sz]ed|not logged in|login required|auth(?:entication)? required/i

export const getCodexQuotaFailureResult = (error: unknown): ProviderQuotaFetchResult => {
  const reason = error instanceof Error ? error.message : String(error)

  return codexAuthFailurePattern.test(reason) ? {kind: 'auth', reason} : {kind: 'transient', reason, retryAfterMs: null}
}

const fetchCodexQuota = async (): Promise<ProviderQuotaFetchResult> => {
  return getCodexAppServerClient()
    .accountRateLimitsRead()
    .then((body): ProviderQuotaFetchResult => {
      return {body, kind: 'ok'}
    })
    .catch(getCodexQuotaFailureResult)
}

const shouldCurrentServerPollProviderQuota = () => {
  return shouldCurrentServerRunMaintenanceLoops() && canCurrentServerOwnDuckdb()
}

const defaultProviderQuotaPollDeps: ProviderQuotaPollDeps = {
  fetchQuota: {'claude-code': fetchClaudeCodeQuota, codex: fetchCodexQuota},
  insertReadings: (readings) => {
    return insertProviderQuotaReadings({readings})
  },
  now: Date.now,
  readConnections: readProviderQuotaPollConnections,
  shouldRun: shouldCurrentServerPollProviderQuota,
}

const getKindConnections = (connections: ProviderQuotaPollConnection[], kind: PolledProviderQuotaKind) => {
  return connections.filter((connection) => {
    return connection.providerKind === kind
  })
}

const isKindDue = ({
  connections,
  kind,
  nowMs,
}: {
  connections: ProviderQuotaPollConnection[]
  kind: PolledProviderQuotaKind
  nowMs: number
}): boolean => {
  return (
    connections.length > 0
    && isProviderQuotaPollDue({
      hasRunningJob: connections.some((connection) => {
        return connection.hasRunningJob
      }),
      nowMs,
      state: getPollState(kind),
    })
  )
}

const getFetchResultReason = (result: ProviderQuotaFetchResult): string => {
  return result.kind === 'ok' ? 'response had no readable limits' : result.reason
}

const logProviderQuotaPollOutcome = ({
  kind,
  outcome,
  result,
}: {
  kind: PolledProviderQuotaKind
  outcome: ProviderQuotaPollOutcome
  result: ProviderQuotaFetchResult
}): void => {
  if (outcome === 'ok') {
    return
  }

  providerQuotaPollLogger.warn(
    `provider-quota-poll:${kind}:${outcome}`,
    `[providerQuota] ${kind} quota reading skipped (${outcome}): ${getFetchResultReason(result)}`,
    {kind, outcome, reason: getFetchResultReason(result)},
  )
}

const getPollOutcome = (result: ProviderQuotaFetchResult, readings: ProviderQuotaReadingInsert[]) => {
  return result.kind === 'ok' ? (readings.length > 0 ? 'ok' : 'unreadable') : result.kind
}

const pollProviderQuotaKind = async ({
  connections,
  deps,
  kind,
  observedAt,
}: {
  connections: ProviderQuotaPollConnection[]
  deps: ProviderQuotaPollDeps
  kind: PolledProviderQuotaKind
  observedAt: Date
}): Promise<ProviderQuotaPollKindResult> => {
  const result = await deps.fetchQuota[kind]()
  const readings =
    result.kind === 'ok'
      ? connections.flatMap((connection) => {
          return providerQuotaReadParsers[kind](result.body, {
            observedAt,
            providerConnectionId: connection.providerConnectionId,
          })
        })
      : []
  const outcome = getPollOutcome(result, readings)

  pollStates.set(
    kind,
    getNextProviderQuotaPollState({
      nowMs: observedAt.getTime(),
      outcome,
      retryAfterMs: result.kind === 'transient' ? result.retryAfterMs : null,
      state: getPollState(kind),
    }),
  )
  logProviderQuotaPollOutcome({kind, outcome, result})

  return {kind, outcome, readings}
}

const getConnectionsReadIntervalMs = (): number => {
  return connectionsReadState.connectedKinds.length > 0
    ? providerQuotaPollConstants.activeIntervalMs
    : providerQuotaPollConstants.idleIntervalMs
}

const isConnectionsReadDue = (nowMs: number): boolean => {
  return (
    connectionsReadState.lastReadAtMs === null
    || nowMs >= connectionsReadState.lastReadAtMs + getConnectionsReadIntervalMs()
  )
}

const couldAnyKindBeDue = (nowMs: number): boolean => {
  return (
    isConnectionsReadDue(nowMs)
    || connectionsReadState.connectedKinds.some((kind) => {
      return isProviderQuotaPollDue({
        hasRunningJob: connectionsReadState.runningJobKinds.includes(kind),
        nowMs,
        state: getPollState(kind),
      })
    })
  )
}

const pollDueProviderQuotaKinds = async (
  deps: ProviderQuotaPollDeps,
  nowMs: number,
): Promise<ProviderQuotaPollWakeResult> => {
  const connections = await deps.readConnections()
  connectionsReadState.connectedKinds = polledProviderQuotaKinds.filter((kind) => {
    return getKindConnections(connections, kind).length > 0
  })
  connectionsReadState.runningJobKinds = polledProviderQuotaKinds.filter((kind) => {
    return getKindConnections(connections, kind).some((connection) => {
      return connection.hasRunningJob
    })
  })
  connectionsReadState.lastReadAtMs = nowMs
  const dueKinds = polledProviderQuotaKinds.filter((kind) => {
    return isKindDue({connections: getKindConnections(connections, kind), kind, nowMs})
  })

  if (dueKinds.length === 0) {
    return {reason: 'no-connection-due', status: 'skipped'}
  }

  const observedAt = new Date(nowMs)
  const results = await Promise.all(
    dueKinds.map((kind) => {
      return pollProviderQuotaKind({connections: getKindConnections(connections, kind), deps, kind, observedAt})
    }),
  )
  const inserted = await deps.insertReadings(
    results.flatMap((result) => {
      return result.readings
    }),
  )

  return {
    inserted,
    outcomes: Object.fromEntries(
      results.map((result) => {
        return [result.kind, result.outcome]
      }),
    ),
    status: 'ran',
  }
}

export const runProviderQuotaPollWake = async (
  deps: ProviderQuotaPollDeps = defaultProviderQuotaPollDeps,
): Promise<ProviderQuotaPollWakeResult> => {
  const nowMs = deps.now()

  return !deps.shouldRun()
    ? {reason: 'maintenance-role', status: 'skipped'}
    : couldAnyKindBeDue(nowMs)
      ? pollDueProviderQuotaKinds(deps, nowMs)
      : {reason: 'not-due', status: 'skipped'}
}

const logProviderQuotaPollCronError = (error: unknown) => {
  if (isExpectedDuckdbOwnerRoleLossError(error)) {
    return
  }

  providerQuotaPollLogger.warn('provider-quota-poll:wake-failure', '[providerQuota] quota poll wake failed', {
    error: error instanceof Error ? error.message : String(error),
  })
}

export const providerQuotaPollCron = new Elysia().use(
  cron({
    name: 'provider-quota-poll',
    pattern: PROVIDER_QUOTA_POLL_INTERVAL,
    protect: true,
    startAt: new Date(Date.now() + START_DELAY_MS),
    run: async () => {
      try {
        await runProviderQuotaPollWake()
      } catch (error) {
        logProviderQuotaPollCronError(error)
      }
    },
  }),
)
