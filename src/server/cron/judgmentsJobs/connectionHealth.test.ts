import {expect, test} from 'bun:test'

import {classifyConnectionFailure, createConnectionError, isConnectionError} from './connectionHealth.ts'

const context = {
  effectiveBaseURL: 'http://127.0.0.1:11434/v1',
  endpointPath: '/v1/chat/completions',
  providerKind: 'ollama',
} as const

test('classifies missing required OpenAI-compatible endpoints as endpoint unavailable', () => {
  const failure = classifyConnectionFailure({context, error: {status: 404}})

  expect(failure.kind).toBe('endpoint_unavailable')
  expect(failure.shouldPauseConnection).toBe(true)
  expect(failure.message).toContain('provider=ollama')
  expect(failure.message).toContain('baseURL=http://127.0.0.1:11434/v1')
  expect(failure.message).toContain('endpoint=/v1/chat/completions')
  expect(failure.message).toContain('status=404')
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
