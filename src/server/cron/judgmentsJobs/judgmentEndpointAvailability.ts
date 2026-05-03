import {createRateLimitedLogger} from '../../utils/rateLimitedLogger.ts'
import {getEndpointAvailabilityKey} from './endpointAvailabilityKey.ts'
import type {ProviderKeyInput} from './providerKey.ts'

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

type JudgmentEndpointProviderInput = ProviderKeyInput & {providerKey?: string | null}

const endpointAvailabilityStates = new Map<string, JudgmentEndpointAvailabilityState>()

const hasEndpointAvailabilityProviderInput = ({
  modelId,
  modelProvider,
  providerConnectionId,
  providerKey,
}: JudgmentEndpointProviderInput): boolean => {
  return Boolean(modelId || modelProvider || providerConnectionId || providerKey)
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

const applyEndpointKeyMisconfiguration = ({
  failureMessage,
  state,
}: {
  failureMessage: string
  state: JudgmentEndpointAvailabilityState
}): void => {
  finishProbe(state)
  state.cooldownExpiresAt = null
  state.lastFailureKind = 'endpoint_misconfigured'
  state.lastFailureMessage = failureMessage
  state.status = 'misconfigured'
}

const getOrCreateEndpointAvailabilityState = ({
  effectiveBaseURL,
  modelId,
  modelProvider,
  providerConnectionId,
  providerKey,
  useOwnerBackedSyntheticProviderId,
}: {effectiveBaseURL: string} & JudgmentEndpointProviderInput): JudgmentEndpointAvailabilityState => {
  const key = getEndpointAvailabilityKey({
    effectiveBaseURL,
    modelId,
    modelProvider,
    providerConnectionId,
    providerKey,
    useOwnerBackedSyntheticProviderId,
  })
  const existing = endpointAvailabilityStates.get(key.endpointAvailabilityKey)
  const endpointIdentitySuffix = `::${key.endpointIdentity}`
  const existingForBaseUrlOnly = hasEndpointAvailabilityProviderInput({
    modelId,
    modelProvider,
    providerConnectionId,
    providerKey,
    useOwnerBackedSyntheticProviderId,
  })
    ? null
    : (Array.from(endpointAvailabilityStates.entries()).find(([existingKey]) => {
        return existingKey.endsWith(endpointIdentitySuffix)
      })?.[1] ?? null)
  const state = existing ?? existingForBaseUrlOnly ?? createHealthyState()

  if (!existing && !existingForBaseUrlOnly) {
    endpointAvailabilityStates.set(key.endpointAvailabilityKey, state)
  }

  if (key.misconfiguration) {
    applyEndpointKeyMisconfiguration({failureMessage: key.misconfiguration, state})
  }

  return state
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
  modelId,
  modelProvider,
  providerConnectionId,
  providerKey,
  status,
  useOwnerBackedSyntheticProviderId,
}: {
  effectiveBaseURL: string
  failureKind: JudgmentEndpointFailureKind
  failureMessage: string
  status: Exclude<JudgmentEndpointAvailabilityStatus, 'healthy' | 'probing'>
} & JudgmentEndpointProviderInput): void => {
  const key = getEndpointAvailabilityKey({
    effectiveBaseURL,
    modelId,
    modelProvider,
    providerConnectionId,
    providerKey,
    useOwnerBackedSyntheticProviderId,
  })
  const state = getOrCreateEndpointAvailabilityState({
    effectiveBaseURL,
    modelId,
    modelProvider,
    providerConnectionId,
    providerKey,
    useOwnerBackedSyntheticProviderId,
  })

  if (key.misconfiguration) {
    applyEndpointKeyMisconfiguration({failureMessage: key.misconfiguration, state})
    endpointAvailabilityLogger.warn(
      `endpoint-availability:misconfigured:${key.endpointAvailabilityKey}`,
      key.misconfiguration,
    )
    return undefined
  }

  finishProbe(state)
  state.cooldownExpiresAt = new Date(Date.now() + COOLDOWN_MS)
  state.lastFailureKind = failureKind
  state.lastFailureMessage = failureMessage
  state.status = status

  endpointAvailabilityLogger.warn(`endpoint-availability:${status}:${key.endpointAvailabilityKey}`, failureMessage)
}

export const getJudgmentEndpointAvailability = ({
  effectiveBaseURL,
  modelId,
  modelProvider,
  providerConnectionId,
  providerKey,
  useOwnerBackedSyntheticProviderId,
}: {effectiveBaseURL: string} & JudgmentEndpointProviderInput): JudgmentEndpointAvailability => {
  return getEndpointAvailabilitySnapshot(
    getOrCreateEndpointAvailabilityState({
      effectiveBaseURL,
      modelId,
      modelProvider,
      providerConnectionId,
      providerKey,
      useOwnerBackedSyntheticProviderId,
    }),
  )
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
  modelId,
  modelProvider,
  providerConnectionId,
  providerKey,
  useOwnerBackedSyntheticProviderId,
}: {effectiveBaseURL: string} & JudgmentEndpointProviderInput): boolean => {
  const key = getEndpointAvailabilityKey({
    effectiveBaseURL,
    modelId,
    modelProvider,
    providerConnectionId,
    providerKey,
    useOwnerBackedSyntheticProviderId,
  })
  const state = getOrCreateEndpointAvailabilityState({
    effectiveBaseURL,
    modelId,
    modelProvider,
    providerConnectionId,
    providerKey,
    useOwnerBackedSyntheticProviderId,
  })
  const now = Date.now()
  const cooldownExpiresAt = state.cooldownExpiresAt?.getTime() ?? null
  const cooldownActive = cooldownExpiresAt != null && cooldownExpiresAt > now

  if (key.misconfiguration) {
    return false
  }

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
    `endpoint-availability:probing:${key.endpointAvailabilityKey}`,
    `Endpoint availability probing for ${effectiveBaseURL}`,
  )

  return true
}

export const recordJudgmentEndpointFailure = ({
  effectiveBaseURL,
  failureKind,
  failureMessage,
  modelId,
  modelProvider,
  providerConnectionId,
  providerKey,
  useOwnerBackedSyntheticProviderId,
}: {
  effectiveBaseURL: string
  failureKind: JudgmentEndpointFailureKind
  failureMessage: string
} & JudgmentEndpointProviderInput): void => {
  if (failureKind === 'other' || failureKind === 'circuit_open') {
    return undefined
  }

  const status = failureKind === 'endpoint_misconfigured' ? 'misconfigured' : 'cooldown'

  return setGatedState({
    effectiveBaseURL,
    failureKind,
    failureMessage,
    modelId,
    modelProvider,
    providerConnectionId,
    providerKey,
    status,
    useOwnerBackedSyntheticProviderId,
  })
}

export const recordJudgmentEndpointSuccess = ({
  effectiveBaseURL,
  modelId,
  modelProvider,
  providerConnectionId,
  providerKey,
  useOwnerBackedSyntheticProviderId,
}: {effectiveBaseURL: string} & JudgmentEndpointProviderInput): void => {
  const key = getEndpointAvailabilityKey({
    effectiveBaseURL,
    modelId,
    modelProvider,
    providerConnectionId,
    providerKey,
    useOwnerBackedSyntheticProviderId,
  })
  const state = getOrCreateEndpointAvailabilityState({
    effectiveBaseURL,
    modelId,
    modelProvider,
    providerConnectionId,
    providerKey,
    useOwnerBackedSyntheticProviderId,
  })

  if (key.misconfiguration) {
    return undefined
  }

  const shouldLog = state.status !== 'healthy' || state.lastFailureKind != null

  finishProbe(state)
  state.cooldownExpiresAt = null
  state.lastFailureKind = null
  state.lastFailureMessage = null
  state.status = 'healthy'

  if (shouldLog) {
    endpointAvailabilityLogger.force(
      `endpoint-availability:healthy:${key.endpointAvailabilityKey}`,
      `Endpoint availability healthy for ${effectiveBaseURL}`,
    )
  }
}

export const resetJudgmentEndpointAvailabilityForTests = (): void => {
  endpointAvailabilityStates.clear()
}
