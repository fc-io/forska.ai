export type ProviderQuotaPollOutcome = 'auth' | 'ok' | 'transient' | 'unreadable'

export type ProviderQuotaPollState = {
  backoffMs: number
  lastAttemptAtMs: number | null
  lastOutcome: ProviderQuotaPollOutcome | null
  retryAfterUntilMs: number | null
}

export const providerQuotaPollConstants = {
  activeIntervalMs: 60_000,
  backoffInitialMs: 120_000,
  backoffMaxMs: 600_000,
  idleIntervalMs: 600_000,
  warnIntervalMs: 3_600_000,
} as const

export const initialProviderQuotaPollState: ProviderQuotaPollState = {
  backoffMs: 0,
  lastAttemptAtMs: null,
  lastOutcome: null,
  retryAfterUntilMs: null,
}

const getProviderQuotaPollIntervalMs = (state: ProviderQuotaPollState, hasRunningJob: boolean): number => {
  return state.lastOutcome === 'transient'
    ? state.backoffMs
    : state.lastOutcome === 'ok' && hasRunningJob
      ? providerQuotaPollConstants.activeIntervalMs
      : providerQuotaPollConstants.idleIntervalMs
}

export const getProviderQuotaPollDueAtMs = ({
  hasRunningJob,
  state,
}: {
  hasRunningJob: boolean
  state: ProviderQuotaPollState
}): number => {
  return state.lastAttemptAtMs === null
    ? 0
    : Math.max(
        state.lastAttemptAtMs + getProviderQuotaPollIntervalMs(state, hasRunningJob),
        state.retryAfterUntilMs ?? 0,
      )
}

export const isProviderQuotaPollDue = ({
  hasRunningJob,
  nowMs,
  state,
}: {
  hasRunningJob: boolean
  nowMs: number
  state: ProviderQuotaPollState
}): boolean => {
  return nowMs >= getProviderQuotaPollDueAtMs({hasRunningJob, state})
}

const getNextBackoffMs = (backoffMs: number): number => {
  return backoffMs === 0
    ? providerQuotaPollConstants.backoffInitialMs
    : Math.min(providerQuotaPollConstants.backoffMaxMs, backoffMs * 2)
}

export const getNextProviderQuotaPollState = ({
  nowMs,
  outcome,
  retryAfterMs,
  state,
}: {
  nowMs: number
  outcome: ProviderQuotaPollOutcome
  retryAfterMs: number | null
  state: ProviderQuotaPollState
}): ProviderQuotaPollState => {
  return {
    backoffMs: outcome === 'transient' ? getNextBackoffMs(state.backoffMs) : 0,
    lastAttemptAtMs: nowMs,
    lastOutcome: outcome,
    retryAfterUntilMs: outcome === 'transient' && retryAfterMs !== null ? nowMs + retryAfterMs : null,
  }
}
