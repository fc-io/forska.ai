import {
  getJudgmentEndpointAvailability,
  recordJudgmentEndpointFailure,
  recordJudgmentEndpointSuccess,
} from './judgmentEndpointAvailability.ts'

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
    || message.includes('endpoint availability gate')
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

const getConnectionTrackingInput = (
  input: string | {effectiveBaseURL: string; failure?: ConnectionFailure; providerConnectionId?: string | null},
): {effectiveBaseURL: string; failure: ConnectionFailure | null; providerConnectionId: string | null} => {
  if (typeof input === 'string') {
    return {effectiveBaseURL: input, failure: null, providerConnectionId: null}
  }

  return {
    effectiveBaseURL: input.effectiveBaseURL,
    failure: input.failure ?? null,
    providerConnectionId: input.providerConnectionId ?? null,
  }
}

export const isCircuitOpen = (baseURL: string): boolean => {
  const state = getJudgmentEndpointAvailability({effectiveBaseURL: baseURL, providerConnectionId: null})

  return state.status !== 'healthy'
}

export const recordConnectionSuccess = (
  input: string | {effectiveBaseURL: string; providerConnectionId?: string | null},
): void => {
  const {effectiveBaseURL, providerConnectionId} = getConnectionTrackingInput(input)

  return recordJudgmentEndpointSuccess({effectiveBaseURL, providerConnectionId})
}

export const recordConnectionFailure = (
  input: string | {effectiveBaseURL: string; failure?: ConnectionFailure; providerConnectionId?: string | null},
): void => {
  const {effectiveBaseURL, failure, providerConnectionId} = getConnectionTrackingInput(input)

  return recordJudgmentEndpointFailure({
    effectiveBaseURL,
    failureKind: failure?.kind ?? 'network_unavailable',
    failureMessage: failure?.message ?? `Connection failure recorded for ${effectiveBaseURL}`,
    providerConnectionId,
  })
}

export const getCircuitStatus = (
  baseURL: string,
): {isOpen: boolean; consecutiveFailures: number; lastFailureTime: Date | null; cooldownRemainingMs: number | null} => {
  const state = getJudgmentEndpointAvailability({effectiveBaseURL: baseURL, providerConnectionId: null})
  const cooldownRemainingMs = state.cooldownExpiresAt
    ? Math.max(0, state.cooldownExpiresAt.getTime() - Date.now())
    : null

  return {
    isOpen: state.status !== 'healthy',
    consecutiveFailures: state.lastFailureKind == null ? 0 : 1,
    lastFailureTime: state.cooldownExpiresAt
      ? new Date(state.cooldownExpiresAt.getTime() - (cooldownRemainingMs ?? 0))
      : null,
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
