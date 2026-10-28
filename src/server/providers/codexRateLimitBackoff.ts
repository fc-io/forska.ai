export const codexRateLimitedFailureCode = 'codex_rate_limited'

export const codexRateLimitBackoffConstants = {
  backoffTurnTimeoutMs: 180_000,
  cooldownInitialMs: 60_000,
  cooldownMaxMs: 600_000,
  healthyTurnTimeoutMs: 900_000,
  minimumLimit: 2,
  rampStepIntervalMs: 60_000,
  rampStepSize: 2,
} as const

type CodexRateLimitBackoffState = {
  configuredLimit: number
  cooldownMs: number
  cooldownUntilMs: number
  decreaseCount: number
  decreasedAtMs: number
  decreasedLimit: number
  firstSuccessAfterDecreaseAtMs: number | null
  lastRateLimitedAtMs: number
}

export type CodexAdaptiveInflight = {
  configuredLimit: number
  cooldownUntil: string | null
  decreaseCount: number
  effectiveLimit: number
  lastRateLimitedAt: string | null
  rateLimitBackoffActive: boolean
}

const backoffStates = new Map<string, CodexRateLimitBackoffState>()

const getConfiguredLimit = (value: number): number => {
  return Math.max(1, Math.trunc(value))
}

const getRampStartMs = (state: CodexRateLimitBackoffState): number | null => {
  return state.firstSuccessAfterDecreaseAtMs === null
    ? null
    : Math.max(state.cooldownUntilMs, state.firstSuccessAfterDecreaseAtMs)
}

const getRampedLimit = (state: CodexRateLimitBackoffState, rampStartMs: number, nowMs: number): number => {
  const rampSteps = Math.floor((nowMs - rampStartMs) / codexRateLimitBackoffConstants.rampStepIntervalMs) + 1

  return Math.min(state.configuredLimit, state.decreasedLimit + rampSteps * codexRateLimitBackoffConstants.rampStepSize)
}

const getStateEffectiveLimit = (state: CodexRateLimitBackoffState, nowMs: number): number => {
  const rampStartMs = getRampStartMs(state)

  return rampStartMs === null || nowMs < rampStartMs ? state.decreasedLimit : getRampedLimit(state, rampStartMs, nowMs)
}

const isStateRecovered = (state: CodexRateLimitBackoffState, nowMs: number): boolean => {
  return nowMs >= state.cooldownUntilMs && getStateEffectiveLimit(state, nowMs) >= state.configuredLimit
}

const getActiveBackoffState = (key: string, configuredLimit: number, nowMs: number) => {
  const state = backoffStates.get(key) ?? null

  return state !== null && state.configuredLimit === configuredLimit && !isStateRecovered(state, nowMs) ? state : null
}

const getAnyActiveBackoffState = (key: string, nowMs: number) => {
  const state = backoffStates.get(key) ?? null

  return state === null ? null : getActiveBackoffState(key, state.configuredLimit, nowMs)
}

const deleteInactiveBackoffState = (key: string, nowMs: number): void => {
  if (getAnyActiveBackoffState(key, nowMs) === null) {
    backoffStates.delete(key)
  }
}

const getIsoOrNull = (valueMs: number | null): string | null => {
  return valueMs === null ? null : new Date(valueMs).toISOString()
}

const getRetryAfterHoldUntilMs = (retryAfterAt: Date | null, nowMs: number): number => {
  const retryAfterAtMs = retryAfterAt?.getTime() ?? Number.NaN

  return Number.isFinite(retryAfterAtMs)
    ? Math.min(retryAfterAtMs, nowMs + codexRateLimitBackoffConstants.cooldownMaxMs)
    : nowMs
}

const getDecreasedState = ({
  configuredLimit,
  nowMs,
  retryAfterAt,
  state,
}: {
  configuredLimit: number
  nowMs: number
  retryAfterAt: Date | null
  state: CodexRateLimitBackoffState | null
}): CodexRateLimitBackoffState => {
  const currentLimit = state ? getStateEffectiveLimit(state, nowMs) : configuredLimit
  const cooldownMs = state
    ? Math.min(codexRateLimitBackoffConstants.cooldownMaxMs, state.cooldownMs * 2)
    : codexRateLimitBackoffConstants.cooldownInitialMs

  return {
    configuredLimit,
    cooldownMs,
    cooldownUntilMs: Math.max(nowMs + cooldownMs, getRetryAfterHoldUntilMs(retryAfterAt, nowMs)),
    decreaseCount: (state?.decreaseCount ?? 0) + 1,
    decreasedAtMs: nowMs,
    decreasedLimit: Math.min(
      configuredLimit,
      Math.max(codexRateLimitBackoffConstants.minimumLimit, Math.floor(currentLimit / 2)),
    ),
    firstSuccessAfterDecreaseAtMs: null,
    lastRateLimitedAtMs: nowMs,
  }
}

const getAdaptiveInflight = (
  state: CodexRateLimitBackoffState | null,
  configuredLimit: number,
  nowMs: number,
): CodexAdaptiveInflight => {
  return state
    ? {
        configuredLimit,
        cooldownUntil: getIsoOrNull(state.cooldownUntilMs),
        decreaseCount: state.decreaseCount,
        effectiveLimit: getStateEffectiveLimit(state, nowMs),
        lastRateLimitedAt: getIsoOrNull(state.lastRateLimitedAtMs),
        rateLimitBackoffActive: true,
      }
    : {
        configuredLimit,
        cooldownUntil: null,
        decreaseCount: 0,
        effectiveLimit: configuredLimit,
        lastRateLimitedAt: null,
        rateLimitBackoffActive: false,
      }
}

export const recordCodexConnectionRateLimit = ({
  configuredLimit,
  key,
  nowMs = Date.now(),
  requestStartedAtMs,
  retryAfterAt,
}: {
  configuredLimit: number
  key: string
  nowMs?: number
  requestStartedAtMs: number
  retryAfterAt: Date | null
}): {adaptiveInflight: CodexAdaptiveInflight; decreased: boolean} => {
  const normalizedConfiguredLimit = getConfiguredLimit(configuredLimit)
  const state = getActiveBackoffState(key, normalizedConfiguredLimit, nowMs)
  const startedBeforeLastDecrease = state !== null && requestStartedAtMs <= state.decreasedAtMs
  const nextState = startedBeforeLastDecrease
    ? {...state, lastRateLimitedAtMs: nowMs}
    : getDecreasedState({configuredLimit: normalizedConfiguredLimit, nowMs, retryAfterAt, state})

  backoffStates.set(key, nextState)

  return {
    adaptiveInflight: getAdaptiveInflight(nextState, normalizedConfiguredLimit, nowMs),
    decreased: !startedBeforeLastDecrease,
  }
}

export const recordCodexConnectionSuccess = ({key, nowMs = Date.now()}: {key: string; nowMs?: number}): void => {
  const state = getAnyActiveBackoffState(key, nowMs)

  deleteInactiveBackoffState(key, nowMs)

  if (state && state.firstSuccessAfterDecreaseAtMs === null) {
    backoffStates.set(key, {...state, firstSuccessAfterDecreaseAtMs: nowMs})
  }
}

export const getCodexConnectionAdaptiveInflight = ({
  configuredLimit,
  key,
  nowMs = Date.now(),
}: {
  configuredLimit: number
  key: string
  nowMs?: number
}): CodexAdaptiveInflight => {
  const normalizedConfiguredLimit = getConfiguredLimit(configuredLimit)

  return getAdaptiveInflight(
    getActiveBackoffState(key, normalizedConfiguredLimit, nowMs),
    normalizedConfiguredLimit,
    nowMs,
  )
}

export const isCodexConnectionRateLimitBackoffActive = (key: string, nowMs = Date.now()): boolean => {
  return getAnyActiveBackoffState(key, nowMs) !== null
}

export const getCodexConnectionTurnTimeoutMs = (key: string, nowMs = Date.now()): number => {
  return isCodexConnectionRateLimitBackoffActive(key, nowMs)
    ? codexRateLimitBackoffConstants.backoffTurnTimeoutMs
    : codexRateLimitBackoffConstants.healthyTurnTimeoutMs
}

export const getCodexConnectionRateLimitCooldownRemainingMs = (key: string, nowMs = Date.now()): number => {
  const state = getAnyActiveBackoffState(key, nowMs)

  return state ? Math.max(0, state.cooldownUntilMs - nowMs) : 0
}

const getNextRampStepAtMs = (rampStartMs: number, nowMs: number): number => {
  const elapsedSteps = Math.floor((nowMs - rampStartMs) / codexRateLimitBackoffConstants.rampStepIntervalMs) + 1

  return rampStartMs + elapsedSteps * codexRateLimitBackoffConstants.rampStepIntervalMs
}

export const getCodexConnectionNextLimitIncreaseAtMs = (key: string, nowMs = Date.now()): number | null => {
  const state = getAnyActiveBackoffState(key, nowMs)
  const rampStartMs = state ? getRampStartMs(state) : null

  return rampStartMs === null ? null : nowMs < rampStartMs ? rampStartMs : getNextRampStepAtMs(rampStartMs, nowMs)
}

export const isCodexRateLimitedError = (error: unknown): boolean => {
  return error instanceof Error && (error as {code?: unknown}).code === codexRateLimitedFailureCode
}

export const resetCodexRateLimitBackoffForTests = (): void => {
  backoffStates.clear()
}
