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
import {getEndpointAvailabilityKey} from './endpointAvailabilityKey.ts'
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

test('classifies Codex websocket 403 as transient throttling', () => {
  const failure = classifyConnectionFailure({
    context: {effectiveBaseURL: 'codex://app-server', endpointPath: null, providerKind: 'codex'},
    error: new Error(
      'codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 403 Forbidden, url: wss://chatgpt.com/backend-api/codex/responses',
    ),
  })

  expect(failure.kind).toBe('rate_limited')
  expect(failure.shouldPauseConnection).toBe(true)
  expect(failure.statusCode).toBe(403)
})

test('keeps Codex transient upstream resets out of the outage path', () => {
  const error = new Error(
    'codex app-server: turn failed: Unexpected content type: Some("text/plain; body: upstream connect error or disconnect/reset before headers. reset reason: connection termination"), when send initialized notification',
  )
  const failure = classifyConnectionFailure({
    context: {effectiveBaseURL: 'codex://app-server', endpointPath: null, providerKind: 'codex'},
    error,
  })

  recordConnectionFailure({effectiveBaseURL: 'codex://app-server', failure, providerConnectionId: null})

  expect(failure.kind).toBe('other')
  expect(failure.shouldPauseConnection).toBe(false)
  expect(isConnectionError(error)).toBe(false)
  expect(
    getJudgmentEndpointAvailability({effectiveBaseURL: 'codex://app-server', providerConnectionId: null}).status,
  ).toBe('healthy')
})

test('classifies circuit-open failures with typed connection errors', () => {
  const error = createConnectionError({
    context: {effectiveBaseURL: 'http://127.0.0.1:1234/v1', endpointPath: null, providerKind: 'sglang'},
    error: new Error('Inference server blocked by circuit breaker'),
  })

  expect(error.failure.kind).toBe('circuit_open')
  expect(isConnectionError(error)).toBe(true)
})

test('does not extend endpoint cooldown from circuit-open gate errors', () => {
  let now = 1_000
  Date.now = () => {
    return now
  }

  const originalFailure = classifyConnectionFailure({context, error: {status: 503}})

  recordConnectionFailure({
    effectiveBaseURL: context.effectiveBaseURL,
    failure: originalFailure,
    providerConnectionId: 'connection-a',
  })

  const originalCooldownExpiresAt = getJudgmentEndpointAvailability({
    effectiveBaseURL: context.effectiveBaseURL,
    providerConnectionId: 'connection-a',
  }).cooldownExpiresAt
  const circuitError = createConnectionError({
    context: {...context, endpointPath: null},
    error: new Error('Inference server blocked by endpoint availability gate'),
  })

  now += 1_000

  recordConnectionFailure({
    effectiveBaseURL: context.effectiveBaseURL,
    failure: circuitError.failure,
    providerConnectionId: 'connection-a',
  })

  const availability = getJudgmentEndpointAvailability({
    effectiveBaseURL: context.effectiveBaseURL,
    providerConnectionId: 'connection-a',
  })

  expect(availability.lastFailureKind).toBe('endpoint_unavailable')
  expect(availability.cooldownExpiresAt?.getTime()).toBe(originalCooldownExpiresAt?.getTime())

  now = (originalCooldownExpiresAt?.getTime() ?? 0) + 1

  expect(
    claimJudgmentEndpointAvailability({
      effectiveBaseURL: context.effectiveBaseURL,
      providerConnectionId: 'connection-a',
    }),
  ).toBe(true)
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

test('builds canonical endpoint availability keys from provider and normalized endpoint identity', () => {
  const rootKey = getEndpointAvailabilityKey({effectiveBaseURL: 'HTTP://Example.COM:80/v1/', modelProvider: 'openai'})
  const pathKey = getEndpointAvailabilityKey({
    effectiveBaseURL: 'https://example.com:443/openai/v1',
    modelProvider: 'openai',
  })
  const defaultPathKey = getEndpointAvailabilityKey({
    effectiveBaseURL: 'https://example.com/v1',
    modelProvider: 'openai',
  })
  const customPortKey = getEndpointAvailabilityKey({
    effectiveBaseURL: 'https://example.com:8443/v1',
    providerConnectionId: 'connection-a',
  })
  const syntheticKey = getEndpointAvailabilityKey({
    effectiveBaseURL: 'https://example.com/v1',
    modelId: 'model-owner-backed',
    modelProvider: 'openai',
    useOwnerBackedSyntheticProviderId: true,
  })

  expect(rootKey).toMatchObject({
    endpointAvailabilityKey: 'provider:openai:default::http://example.com',
    endpointIdentity: 'http://example.com',
    misconfiguration: null,
    providerKey: 'provider:openai:default',
  })
  expect(pathKey.endpointAvailabilityKey).toBe('provider:openai:default::https://example.com/openai')
  expect(defaultPathKey.endpointAvailabilityKey).toBe('provider:openai:default::https://example.com')
  expect(pathKey.endpointAvailabilityKey).not.toBe(defaultPathKey.endpointAvailabilityKey)
  expect(customPortKey.endpointAvailabilityKey).toBe('connection-a::https://example.com:8443')
  expect(syntheticKey.endpointAvailabilityKey).toBe('owner-backed:model-owner-backed::https://example.com')
})

test('marks endpoint URLs with credentials, queries, or fragments as misconfigured', () => {
  const credentialKey = getEndpointAvailabilityKey({
    effectiveBaseURL: 'https://user:pass@example.com/v1',
    modelProvider: 'openai',
  })
  const queryAvailability = getJudgmentEndpointAvailability({
    effectiveBaseURL: 'https://example.com/v1?debug=true',
    modelProvider: 'openai',
  })
  const fragmentAvailability = getJudgmentEndpointAvailability({
    effectiveBaseURL: 'https://example.com/v1#models',
    modelProvider: 'openai',
  })

  expect(credentialKey.misconfiguration).toContain('credentials')
  expect(queryAvailability).toMatchObject({lastFailureKind: 'endpoint_misconfigured', status: 'misconfigured'})
  expect(fragmentAvailability).toMatchObject({lastFailureKind: 'endpoint_misconfigured', status: 'misconfigured'})
  expect(
    claimJudgmentEndpointAvailability({effectiveBaseURL: 'https://example.com/v1?debug=true', modelProvider: 'openai'}),
  ).toBe(false)
})

test('keeps unhealthy sibling endpoints isolated under one provider bucket', () => {
  const failure = classifyConnectionFailure({
    context: {
      effectiveBaseURL: 'http://runtime.test:80/v1',
      endpointPath: '/v1/chat/completions',
      providerKind: 'openai',
    },
    error: {status: 503},
  })

  recordConnectionFailure({
    effectiveBaseURL: 'http://runtime.test:80/v1',
    failure,
    modelProvider: 'openai',
    providerConnectionId: null,
  })

  expect(
    getJudgmentEndpointAvailability({
      effectiveBaseURL: 'http://runtime.test/v1',
      modelProvider: 'openai',
      providerConnectionId: null,
    }).status,
  ).toBe('cooldown')
  expect(
    getJudgmentEndpointAvailability({
      effectiveBaseURL: 'http://runtime.test/openai/v1',
      modelProvider: 'openai',
      providerConnectionId: null,
    }).status,
  ).toBe('healthy')
})

test('uses one Codex app-server endpoint identity that may skip HTTP probing', () => {
  const key = getEndpointAvailabilityKey({effectiveBaseURL: 'codex://app-server', modelProvider: 'codex'})

  expect(key).toMatchObject({
    endpointAvailabilityKey: 'codex:default::codex://app-server',
    endpointIdentity: 'codex://app-server',
    misconfiguration: null,
    shouldSkipHttpProbe: true,
  })
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
