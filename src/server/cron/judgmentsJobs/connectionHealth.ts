/**
 * Connection health tracking with circuit breaker pattern.
 *
 * When the inference server is down, we want to:
 * 1. Stop hammering it with requests (circuit breaker)
 * 2. Automatically resume when it's back up (cooldown-based recovery)
 *
 * The circuit breaker has three states:
 * - CLOSED: Normal operation, requests flow through
 * - OPEN: Too many failures, requests are blocked
 * - HALF-OPEN: After cooldown, allow one test request
 */

import {createRateLimitedLogger} from '../../utils/rateLimitedLogger.ts'

// Circuit breaker configuration
const CIRCUIT_BREAKER_THRESHOLD = 5 // Number of consecutive failures to open circuit
const COOLDOWN_MS = 30_000 // 30 seconds before attempting retry

// Rate-limited logger for circuit breaker events (30s window)
const circuitLogger = createRateLimitedLogger({windowMs: 30_000})

// State tracking (per baseURL to handle multiple inference servers)
type CircuitState = {consecutiveFailures: number; lastFailureTime: Date | null; isOpen: boolean}

const circuitStates = new Map<string, CircuitState>()

export type ConnectionFailureKind =
  | 'network_unavailable'
  | 'endpoint_unavailable'
  | 'endpoint_misconfigured'
  | 'rate_limited'
  | 'circuit_open'
  | 'other'

export type ConnectionFailure = {
  effectiveBaseURL: string
  endpointPath: string | null
  kind: ConnectionFailureKind
  likelyCause: string
  message: string
  providerKind: string | null
  shouldPauseConnection: boolean
  statusCode: number | null
}

type ConnectionFailureContext = {effectiveBaseURL: string; endpointPath: string | null; providerKind: string | null}

const openAICompatibleRequiredEndpoints = new Set(['/v1/chat/completions', '/v1/models', '/v1/responses'])

const getTrimmedValue = (value: string | null | undefined): string | null => {
  const normalized = String(value ?? '').trim()

  return normalized === '' ? null : normalized
}

const getNormalizedEndpointPath = (value: string | null | undefined): string | null => {
  const trimmed = getTrimmedValue(value)

  if (!trimmed) {
    return null
  }

  const withoutQuery = trimmed.split('?')[0] ?? trimmed

  return withoutQuery.startsWith('/') ? withoutQuery : `/${withoutQuery}`
}

const getErrorStatusCode = (error: unknown): number | null => {
  if (!error || typeof error !== 'object') return null
  const raw = 'status' in error ? (error as {status?: unknown}).status : null
  const status = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(status) ? status : null
}

const getErrorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error)
}

const getNormalizedProviderKind = (providerKind: string | null | undefined): string | null => {
  const normalized = getTrimmedValue(providerKind)

  return normalized ? normalized.toLowerCase() : null
}

const getNormalizedConnectionFailureContext = ({
  effectiveBaseURL,
  endpointPath,
  providerKind,
}: ConnectionFailureContext): ConnectionFailureContext => {
  return {
    effectiveBaseURL,
    endpointPath: getNormalizedEndpointPath(endpointPath),
    providerKind: getNormalizedProviderKind(providerKind),
  }
}

const isCircuitOpenError = (error: unknown): boolean => {
  const message = getErrorMessage(error).toLowerCase()

  return (
    message.includes('circuit breaker')
    || message.includes('blocked by circuit breaker')
    || (error instanceof ConnectionError && error.failure.kind === 'circuit_open')
  )
}

const isNetworkError = (error: unknown): boolean => {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase()
    return (
      msg.includes('connect')
      || msg.includes('econnrefused')
      || msg.includes('econnreset')
      || msg.includes('enotfound')
      || msg.includes('etimedout')
      || msg.includes('timeout')
      || msg.includes('socket')
      || msg.includes('network')
      || msg.includes('fetch failed')
      || msg.includes('bad gateway')
      || msg.includes('service unavailable')
      || msg.includes('gateway timeout')
      || msg.includes('unable to connect')
      || error.name === 'TypeError'
      || error.name === 'AbortError'
      || error.name === 'APIConnectionError'
    )
  }

  return false
}

const getLikelyCause = ({
  endpointPath,
  kind,
  statusCode,
}: {
  endpointPath: string | null
  kind: ConnectionFailureKind
  statusCode: number | null
}): string => {
  return kind === 'circuit_open'
    ? 'recent endpoint outages opened the circuit breaker'
    : kind === 'rate_limited'
      ? 'the provider is throttling requests'
      : kind === 'network_unavailable'
        ? 'the provider could not be reached over the network'
        : kind === 'endpoint_unavailable'
          ? statusCode === 404 && endpointPath
            ? `the required endpoint ${endpointPath} is missing or the base URL is pointed at the wrong service`
            : 'the provider endpoint is temporarily unavailable'
          : kind === 'endpoint_misconfigured'
            ? statusCode === 405
              ? 'the server reached this endpoint but does not allow the required method'
              : statusCode === 501
                ? 'the server does not implement the required inference endpoint'
                : 'the provider endpoint does not match the expected inference API'
            : 'the failure does not look like a provider-wide outage'
}

const getConnectionFailureMessage = ({
  effectiveBaseURL,
  endpointPath,
  kind,
  likelyCause,
  providerKind,
  statusCode,
}: Omit<ConnectionFailure, 'message' | 'shouldPauseConnection'>): string => {
  const providerLabel = providerKind ?? 'unknown'
  const endpointLabel = endpointPath ?? '(none)'
  const statusLabel = statusCode == null ? 'n/a' : String(statusCode)

  return `Inference outage classified as ${kind} for provider=${providerLabel} baseURL=${effectiveBaseURL} endpoint=${endpointLabel} status=${statusLabel}. Likely cause: ${likelyCause}.`
}

export const classifyConnectionFailure = ({
  error,
  context,
}: {
  context: ConnectionFailureContext
  error: unknown
}): ConnectionFailure => {
  const normalizedContext = getNormalizedConnectionFailureContext(context)
  const statusCode = getErrorStatusCode(error)
  const endpointPath = normalizedContext.endpointPath
  const isRequiredOpenAICompatibleEndpoint = Boolean(
    endpointPath && openAICompatibleRequiredEndpoints.has(endpointPath),
  )
  const kind: ConnectionFailureKind = isCircuitOpenError(error)
    ? 'circuit_open'
    : statusCode === 429
      ? 'rate_limited'
      : isRequiredOpenAICompatibleEndpoint && statusCode === 404
        ? 'endpoint_unavailable'
        : isRequiredOpenAICompatibleEndpoint && (statusCode === 405 || statusCode === 501)
          ? 'endpoint_misconfigured'
          : statusCode === 408
            ? 'network_unavailable'
            : statusCode != null && statusCode >= 500
              ? 'endpoint_unavailable'
              : isNetworkError(error)
                ? 'network_unavailable'
                : 'other'
  const likelyCause = getLikelyCause({endpointPath, kind, statusCode})

  return {
    effectiveBaseURL: normalizedContext.effectiveBaseURL,
    endpointPath,
    kind,
    likelyCause,
    message: getConnectionFailureMessage({
      effectiveBaseURL: normalizedContext.effectiveBaseURL,
      endpointPath,
      kind,
      likelyCause,
      providerKind: normalizedContext.providerKind,
      statusCode,
    }),
    providerKind: normalizedContext.providerKind,
    shouldPauseConnection: kind !== 'other',
    statusCode,
  }
}

export const createConnectionError = ({
  context,
  error,
}: {
  context: ConnectionFailureContext
  error: unknown
}): ConnectionError => {
  const failure = classifyConnectionFailure({context, error})

  return new ConnectionError(failure.message, failure.effectiveBaseURL, failure)
}

const getOrCreateState = (baseURL: string): CircuitState => {
  let state = circuitStates.get(baseURL)
  if (!state) {
    state = {consecutiveFailures: 0, lastFailureTime: null, isOpen: false}
    circuitStates.set(baseURL, state)
  }
  return state
}

/**
 * Check if the circuit breaker is open (blocking requests).
 * If cooldown has expired, the circuit moves to half-open state.
 */
export const isCircuitOpen = (baseURL: string): boolean => {
  const state = getOrCreateState(baseURL)

  if (state.consecutiveFailures < CIRCUIT_BREAKER_THRESHOLD) {
    return false
  }

  if (!state.lastFailureTime) {
    return false
  }

  const timeSinceLastFailure = Date.now() - state.lastFailureTime.getTime()
  const cooldownExpired = timeSinceLastFailure > COOLDOWN_MS

  if (cooldownExpired) {
    // Move to half-open state - allow a test request
    circuitLogger.log(
      `circuit:half-open:${baseURL}`,
      `Circuit breaker half-open for ${baseURL} - allowing test request`,
    )
    // Reset to allow one retry, but keep some failure count
    // so we don't need full threshold again if it fails
    state.consecutiveFailures = CIRCUIT_BREAKER_THRESHOLD - 1
    state.isOpen = false
    return false
  }

  if (!state.isOpen) {
    state.isOpen = true
    // Force log state transitions (important events)
    circuitLogger.force(
      `circuit:open:${baseURL}`,
      `Circuit breaker OPEN for ${baseURL} - blocking requests for ${COOLDOWN_MS}ms`,
    )
  }

  return true
}

/**
 * Record a successful connection - reset the circuit breaker.
 */
export const recordConnectionSuccess = (baseURL: string): void => {
  const state = getOrCreateState(baseURL)
  if (state.consecutiveFailures > 0 || state.isOpen) {
    // Force log recovery (important event) and reset rate limiter for this URL
    circuitLogger.force(`circuit:closed:${baseURL}`, `Circuit breaker CLOSED for ${baseURL} - connection restored`)
    circuitLogger.reset(`circuit:failure:${baseURL}`)
  }
  state.consecutiveFailures = 0
  state.lastFailureTime = null
  state.isOpen = false
}

/**
 * Record a connection failure - may trip the circuit breaker.
 */
export const recordConnectionFailure = (baseURL: string): void => {
  const state = getOrCreateState(baseURL)
  state.consecutiveFailures += 1
  state.lastFailureTime = new Date()

  if (state.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
    // Rate-limited: only log once per 30s window, with count of suppressed logs
    circuitLogger.warn(
      `circuit:failure:${baseURL}`,
      `Circuit breaker: ${state.consecutiveFailures} consecutive failures for ${baseURL}`,
    )
  }
}

/**
 * Get current circuit breaker status for monitoring/debugging.
 */
export const getCircuitStatus = (
  baseURL: string,
): {isOpen: boolean; consecutiveFailures: number; lastFailureTime: Date | null; cooldownRemainingMs: number | null} => {
  const state = getOrCreateState(baseURL)
  const cooldownRemainingMs =
    state.lastFailureTime && state.isOpen
      ? Math.max(0, COOLDOWN_MS - (Date.now() - state.lastFailureTime.getTime()))
      : null

  return {
    isOpen: state.isOpen,
    consecutiveFailures: state.consecutiveFailures,
    lastFailureTime: state.lastFailureTime,
    cooldownRemainingMs,
  }
}

/**
 * Check if an error is a connection-related error.
 * These errors indicate the server is unreachable, not that our request was bad.
 */
export const isConnectionError = (error: unknown): boolean => {
  return error instanceof ConnectionError
    ? error.failure.shouldPauseConnection
    : classifyConnectionFailure({context: {effectiveBaseURL: 'unknown', endpointPath: null, providerKind: null}, error})
        .shouldPauseConnection
}

/**
 * Custom error class for connection errors.
 * Allows callers to distinguish connection issues from other errors.
 */
export class ConnectionError extends Error {
  constructor(
    message: string,
    public readonly baseURL: string,
    public readonly failure: ConnectionFailure,
  ) {
    super(message)
    this.name = 'ConnectionError'
  }
}
