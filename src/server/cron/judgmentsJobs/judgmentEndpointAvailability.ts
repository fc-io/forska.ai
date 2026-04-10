import {createRateLimitedLogger} from '../../utils/rateLimitedLogger.ts'

const COOLDOWN_MS = 30_000

const endpointAvailabilityLogger = createRateLimitedLogger({windowMs: 30_000})

type JudgmentEndpointFailureKind =
  | 'network_unavailable'
  | 'endpoint_unavailable'
  | 'endpoint_misconfigured'
  | 'rate_limited'
  | 'circuit_open'
  | 'other'

export type JudgmentEndpointAvailabilityStatus = 'healthy' | 'cooldown' | 'probing' | 'misconfigured'

type JudgmentEndpointAvailabilityState = {
  cooldownExpiresAt: Date | null
  lastFailureKind: JudgmentEndpointFailureKind | null
  lastFailureMessage: string | null
  probePromise: Promise<void> | null
  resolveProbe: (() => void) | null
  status: JudgmentEndpointAvailabilityStatus
}

export type JudgmentEndpointAvailability = {
  cooldownExpiresAt: Date | null
  lastFailureKind: JudgmentEndpointFailureKind | null
  lastFailureMessage: string | null
  probePromise: Promise<void> | null
  status: JudgmentEndpointAvailabilityStatus
}

export type JudgmentEndpointAvailabilityDiagnostics = {
  cooldownRemainingMs: number | null
  lastFailureKind: JudgmentEndpointFailureKind | null
  lastFailureMessage: string | null
  probeInProgress: boolean
  status: JudgmentEndpointAvailabilityStatus
}

const endpointAvailabilityStates = new Map<string, JudgmentEndpointAvailabilityState>()

const getEndpointAvailabilityKey = ({
  effectiveBaseURL,
  providerConnectionId,
}: {
  effectiveBaseURL: string
  providerConnectionId: string | null
}): string => {
  return `${providerConnectionId ?? 'unknown'}::${effectiveBaseURL}`
}

const createHealthyState = (): JudgmentEndpointAvailabilityState => {
  return {
    cooldownExpiresAt: null,
    lastFailureKind: null,
    lastFailureMessage: null,
    probePromise: null,
    resolveProbe: null,
    status: 'healthy',
  }
}

const getOrCreateEndpointAvailabilityState = ({
  effectiveBaseURL,
  providerConnectionId,
}: {
  effectiveBaseURL: string
  providerConnectionId: string | null
}): JudgmentEndpointAvailabilityState => {
  const key = getEndpointAvailabilityKey({effectiveBaseURL, providerConnectionId})
  const existing = endpointAvailabilityStates.get(key)

  if (existing) {
    return existing
  }

  const created = createHealthyState()
  endpointAvailabilityStates.set(key, created)
  return created
}

const getEndpointAvailabilitySnapshot = (state: JudgmentEndpointAvailabilityState): JudgmentEndpointAvailability => {
  return {
    cooldownExpiresAt: state.cooldownExpiresAt,
    lastFailureKind: state.lastFailureKind,
    lastFailureMessage: state.lastFailureMessage,
    probePromise: state.probePromise,
    status: state.status,
  }
}

const finishProbe = (state: JudgmentEndpointAvailabilityState): void => {
  state.resolveProbe?.()
  state.probePromise = null
  state.resolveProbe = null
}

const setGatedState = ({
  effectiveBaseURL,
  failureKind,
  failureMessage,
  providerConnectionId,
  status,
}: {
  effectiveBaseURL: string
  failureKind: JudgmentEndpointFailureKind
  failureMessage: string
  providerConnectionId: string | null
  status: Exclude<JudgmentEndpointAvailabilityStatus, 'healthy' | 'probing'>
}): void => {
  const state = getOrCreateEndpointAvailabilityState({effectiveBaseURL, providerConnectionId})

  finishProbe(state)
  state.cooldownExpiresAt = new Date(Date.now() + COOLDOWN_MS)
  state.lastFailureKind = failureKind
  state.lastFailureMessage = failureMessage
  state.status = status

  endpointAvailabilityLogger.warn(
    `endpoint-availability:${status}:${providerConnectionId ?? 'unknown'}:${effectiveBaseURL}`,
    failureMessage,
  )
}

export const getJudgmentEndpointAvailability = ({
  effectiveBaseURL,
  providerConnectionId,
}: {
  effectiveBaseURL: string
  providerConnectionId: string | null
}): JudgmentEndpointAvailability => {
  return getEndpointAvailabilitySnapshot(getOrCreateEndpointAvailabilityState({effectiveBaseURL, providerConnectionId}))
}

export const getJudgmentEndpointAvailabilityDiagnostics = (
  availability: JudgmentEndpointAvailability,
): JudgmentEndpointAvailabilityDiagnostics => {
  const cooldownRemainingMs = availability.cooldownExpiresAt
    ? Math.max(0, availability.cooldownExpiresAt.getTime() - Date.now())
    : null

  return {
    cooldownRemainingMs,
    lastFailureKind: availability.lastFailureKind,
    lastFailureMessage: availability.lastFailureMessage,
    probeInProgress: availability.status === 'probing' || availability.probePromise !== null,
    status: availability.status,
  }
}

export const claimJudgmentEndpointAvailability = ({
  effectiveBaseURL,
  providerConnectionId,
}: {
  effectiveBaseURL: string
  providerConnectionId: string | null
}): boolean => {
  const state = getOrCreateEndpointAvailabilityState({effectiveBaseURL, providerConnectionId})
  const now = Date.now()
  const cooldownExpiresAt = state.cooldownExpiresAt?.getTime() ?? null
  const cooldownActive = cooldownExpiresAt != null && cooldownExpiresAt > now

  if (state.status === 'healthy') {
    return true
  }

  if (state.status === 'probing') {
    return false
  }

  if (cooldownActive) {
    return false
  }

  let resolveProbe: () => void = () => {
    return undefined
  }

  state.probePromise = new Promise<void>((resolve) => {
    resolveProbe = resolve
  })
  state.resolveProbe = resolveProbe
  state.cooldownExpiresAt = null
  state.status = 'probing'

  endpointAvailabilityLogger.log(
    `endpoint-availability:probing:${providerConnectionId ?? 'unknown'}:${effectiveBaseURL}`,
    `Endpoint availability probing for ${effectiveBaseURL}`,
  )

  return true
}

export const recordJudgmentEndpointFailure = ({
  effectiveBaseURL,
  failureKind,
  failureMessage,
  providerConnectionId,
}: {
  effectiveBaseURL: string
  failureKind: JudgmentEndpointFailureKind
  failureMessage: string
  providerConnectionId: string | null
}): void => {
  if (failureKind === 'other') {
    return undefined
  }

  const status = failureKind === 'endpoint_misconfigured' ? 'misconfigured' : 'cooldown'

  return setGatedState({effectiveBaseURL, failureKind, failureMessage, providerConnectionId, status})
}

export const recordJudgmentEndpointSuccess = ({
  effectiveBaseURL,
  providerConnectionId,
}: {
  effectiveBaseURL: string
  providerConnectionId: string | null
}): void => {
  const state = getOrCreateEndpointAvailabilityState({effectiveBaseURL, providerConnectionId})
  const shouldLog = state.status !== 'healthy' || state.lastFailureKind != null

  finishProbe(state)
  state.cooldownExpiresAt = null
  state.lastFailureKind = null
  state.lastFailureMessage = null
  state.status = 'healthy'

  if (shouldLog) {
    endpointAvailabilityLogger.force(
      `endpoint-availability:healthy:${providerConnectionId ?? 'unknown'}:${effectiveBaseURL}`,
      `Endpoint availability healthy for ${effectiveBaseURL}`,
    )
  }
}

export const resetJudgmentEndpointAvailabilityForTests = (): void => {
  endpointAvailabilityStates.clear()
}
