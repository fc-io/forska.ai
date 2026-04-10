import {afterEach, expect, test} from 'bun:test'

import {
  classifyConnectionFailure,
  createConnectionError,
  formatConnectionOutageMessage,
  isConnectionError,
  parseConnectionFailureMessage,
  recordConnectionFailure,
  recordConnectionSuccess,
} from './connectionHealth.ts'
import {
  claimJudgmentEndpointAvailability,
  getJudgmentEndpointAvailability,
  resetJudgmentEndpointAvailabilityForTests,
} from './judgmentEndpointAvailability.ts'

const context = {
  effectiveBaseURL: 'http://127.0.0.1:11434/v1',
  endpointPath: '/v1/chat/completions',
  providerKind: 'ollama',
} as const

const realDateNow = Date.now

afterEach(() => {
  Date.now = realDateNow
  resetJudgmentEndpointAvailabilityForTests()
})

test('classifies missing required OpenAI-compatible endpoints as endpoint unavailable', () => {
  const failure = classifyConnectionFailure({context, error: {status: 404}})

  expect(failure.kind).toBe('endpoint_unavailable')
  expect(failure.shouldPauseConnection).toBe(true)
  expect(failure.message).toContain('provider=ollama')
  expect(failure.message).toContain('baseURL=http://127.0.0.1:11434/v1')
  expect(failure.message).toContain('endpoint=/v1/chat/completions')
  expect(failure.message).toContain('status=404')
  expect(failure.message).toContain('Forska paused dispatch for this connection until the provider health check passes')
})

test('formats operator-facing outage messages with next probe timing when known', () => {
  const failure = classifyConnectionFailure({context, error: {status: 503}})
  const cooldownExpiresAt = new Date('2026-04-10T12:34:56.000Z')

  expect(
    formatConnectionOutageMessage({
      cooldownExpiresAt,
      failure,
      promptAction: 'Prompt requeued because the provider endpoint is unavailable.',
    }),
  ).toContain('Next health probe not before 2026-04-10T12:34:56.000Z')
})

test('parses the shared provider outage wording', () => {
  const failure = classifyConnectionFailure({context, error: {status: 503}})

  expect(parseConnectionFailureMessage(failure.message)).toMatchObject({
    effectiveBaseURL: context.effectiveBaseURL,
    endpointPath: context.endpointPath,
    kind: 'endpoint_unavailable',
    providerKind: 'ollama',
    statusCode: 503,
  })
})

test('classifies 405 and 501 on required OpenAI-compatible endpoints as endpoint misconfigured', () => {
  const methodFailure = classifyConnectionFailure({context, error: {status: 405}})
  const notImplementedFailure = classifyConnectionFailure({
    context: {...context, endpointPath: '/v1/models'},
    error: {status: 501},
  })

  expect(methodFailure.kind).toBe('endpoint_misconfigured')
  expect(methodFailure.likelyCause).toContain('does not allow the required method')
  expect(notImplementedFailure.kind).toBe('endpoint_misconfigured')
  expect(notImplementedFailure.likelyCause).toContain('does not implement the required inference endpoint')
})

test('keeps prompt validation failures out of the outage path', () => {
  const badRequest = classifyConnectionFailure({context, error: {status: 400}})
  const unprocessable = classifyConnectionFailure({context, error: {status: 422}})

  expect(badRequest.kind).toBe('other')
  expect(badRequest.shouldPauseConnection).toBe(false)
  expect(unprocessable.kind).toBe('other')
  expect(unprocessable.shouldPauseConnection).toBe(false)
  expect(isConnectionError({status: 422})).toBe(false)
})

test('classifies circuit-open failures with typed connection errors', () => {
  const error = createConnectionError({
    context: {effectiveBaseURL: 'http://127.0.0.1:1234/v1', endpointPath: null, providerKind: 'sglang'},
    error: new Error('Inference server blocked by circuit breaker'),
  })

  expect(error.failure.kind).toBe('circuit_open')
  expect(isConnectionError(error)).toBe(true)
})

test('tracks endpoint availability by provider connection and effective base URL', () => {
  const failure = classifyConnectionFailure({context, error: {status: 404}})

  recordConnectionFailure({effectiveBaseURL: context.effectiveBaseURL, failure, providerConnectionId: 'connection-a'})

  expect(
    getJudgmentEndpointAvailability({effectiveBaseURL: context.effectiveBaseURL, providerConnectionId: 'connection-a'}),
  ).toMatchObject({lastFailureKind: 'endpoint_unavailable', status: 'cooldown'})
  expect(
    getJudgmentEndpointAvailability({effectiveBaseURL: context.effectiveBaseURL, providerConnectionId: 'connection-b'})
      .status,
  ).toBe('healthy')
})

test('allows a single half-open probe and resets state after a successful probe', () => {
  let now = 1_000
  Date.now = () => {
    return now
  }

  const failure = classifyConnectionFailure({context, error: {status: 501}})

  recordConnectionFailure({effectiveBaseURL: context.effectiveBaseURL, failure, providerConnectionId: 'connection-a'})

  expect(
    getJudgmentEndpointAvailability({effectiveBaseURL: context.effectiveBaseURL, providerConnectionId: 'connection-a'})
      .status,
  ).toBe('misconfigured')
  expect(
    claimJudgmentEndpointAvailability({
      effectiveBaseURL: context.effectiveBaseURL,
      providerConnectionId: 'connection-a',
    }),
  ).toBe(false)

  now += 30_001

  expect(
    claimJudgmentEndpointAvailability({
      effectiveBaseURL: context.effectiveBaseURL,
      providerConnectionId: 'connection-a',
    }),
  ).toBe(true)

  const probingState = getJudgmentEndpointAvailability({
    effectiveBaseURL: context.effectiveBaseURL,
    providerConnectionId: 'connection-a',
  })

  expect(probingState.status).toBe('probing')
  expect(probingState.probePromise).toBeInstanceOf(Promise)
  expect(
    claimJudgmentEndpointAvailability({
      effectiveBaseURL: context.effectiveBaseURL,
      providerConnectionId: 'connection-a',
    }),
  ).toBe(false)

  recordConnectionSuccess({effectiveBaseURL: context.effectiveBaseURL, providerConnectionId: 'connection-a'})

  expect(
    getJudgmentEndpointAvailability({effectiveBaseURL: context.effectiveBaseURL, providerConnectionId: 'connection-a'}),
  ).toMatchObject({
    cooldownExpiresAt: null,
    lastFailureKind: null,
    lastFailureMessage: null,
    probePromise: null,
    status: 'healthy',
  })
})
