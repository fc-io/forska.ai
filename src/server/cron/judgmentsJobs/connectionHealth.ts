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

// Circuit breaker configuration
const CIRCUIT_BREAKER_THRESHOLD = 5 // Number of consecutive failures to open circuit
const COOLDOWN_MS = 30_000 // 30 seconds before attempting retry

// State tracking (per baseURL to handle multiple inference servers)
type CircuitState = {
  consecutiveFailures: number
  lastFailureTime: Date | null
  isOpen: boolean
}

const circuitStates = new Map<string, CircuitState>()

const getOrCreateState = (baseURL: string): CircuitState => {
  let state = circuitStates.get(baseURL)
  if (!state) {
    state = {
      consecutiveFailures: 0,
      lastFailureTime: null,
      isOpen: false,
    }
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
    console.log(`Circuit breaker half-open for ${baseURL} - allowing test request after ${COOLDOWN_MS}ms cooldown`)
    // Reset to allow one retry, but keep some failure count
    // so we don't need full threshold again if it fails
    state.consecutiveFailures = CIRCUIT_BREAKER_THRESHOLD - 1
    state.isOpen = false
    return false
  }

  if (!state.isOpen) {
    state.isOpen = true
    console.log(`Circuit breaker OPEN for ${baseURL} - blocking requests for ${COOLDOWN_MS}ms`)
  }

  return true
}

/**
 * Record a successful connection - reset the circuit breaker.
 */
export const recordConnectionSuccess = (baseURL: string): void => {
  const state = getOrCreateState(baseURL)
  if (state.consecutiveFailures > 0 || state.isOpen) {
    console.log(`Circuit breaker CLOSED for ${baseURL} - connection restored`)
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

  if (state.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD && !state.isOpen) {
    console.log(
      `Circuit breaker threshold reached for ${baseURL} (${state.consecutiveFailures} consecutive failures)`,
    )
  }
}

/**
 * Get current circuit breaker status for monitoring/debugging.
 */
export const getCircuitStatus = (
  baseURL: string,
): {
  isOpen: boolean
  consecutiveFailures: number
  lastFailureTime: Date | null
  cooldownRemainingMs: number | null
} => {
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
  if (error instanceof Error) {
    const msg = error.message.toLowerCase()
    return (
      msg.includes('connect') ||
      msg.includes('econnrefused') ||
      msg.includes('econnreset') ||
      msg.includes('enotfound') ||
      msg.includes('etimedout') ||
      msg.includes('timeout') ||
      msg.includes('socket') ||
      msg.includes('network') ||
      msg.includes('fetch failed') ||
      msg.includes('unable to connect') ||
      error.name === 'TypeError' || // fetch failures often throw TypeError
      error.name === 'AbortError' // request was aborted (often due to timeout)
    )
  }
  return false
}

/**
 * Custom error class for connection errors.
 * Allows callers to distinguish connection issues from other errors.
 */
export class ConnectionError extends Error {
  constructor(
    message: string,
    public readonly baseURL: string,
  ) {
    super(message)
    this.name = 'ConnectionError'
  }
}
