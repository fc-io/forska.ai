import {beforeEach, expect, test} from 'bun:test'

import {
  codexRateLimitBackoffConstants,
  getCodexConnectionAdaptiveInflight,
  getCodexConnectionNextLimitIncreaseAtMs,
  getCodexConnectionRateLimitCooldownRemainingMs,
  getCodexConnectionTurnTimeoutMs,
  isCodexConnectionRateLimitBackoffActive,
  recordCodexConnectionRateLimit,
  recordCodexConnectionSuccess,
  resetCodexRateLimitBackoffForTests,
} from './codexRateLimitBackoff.ts'

const key = 'codex-connection'
const startMs = Date.parse('2026-10-28T10:47:32.000Z')
const secondMs = 1000
const minuteMs = 60 * secondMs

const recordRateLimit = ({
  configuredLimit = 35,
  nowMs,
  requestStartedAtMs = nowMs,
  retryAfterAt = null,
}: {
  configuredLimit?: number
  nowMs: number
  requestStartedAtMs?: number
  retryAfterAt?: Date | null
}) => {
  return recordCodexConnectionRateLimit({configuredLimit, key, nowMs, requestStartedAtMs, retryAfterAt})
}

const getEffectiveLimit = (nowMs: number, configuredLimit = 35): number => {
  return getCodexConnectionAdaptiveInflight({configuredLimit, key, nowMs}).effectiveLimit
}

beforeEach(() => {
  resetCodexRateLimitBackoffForTests()
})

test('a healthy connection runs at its configured limit with no backoff', () => {
  expect(getCodexConnectionAdaptiveInflight({configuredLimit: 35, key, nowMs: startMs})).toEqual({
    configuredLimit: 35,
    cooldownUntil: null,
    decreaseCount: 0,
    effectiveLimit: 35,
    lastRateLimitedAt: null,
    rateLimitBackoffActive: false,
  })
  expect(getCodexConnectionTurnTimeoutMs(key, startMs)).toBe(900_000)
})

test('the first rate limit halves the limit and holds it for a 60 s cooldown', () => {
  const {adaptiveInflight, decreased} = recordRateLimit({nowMs: startMs})

  expect(decreased).toBe(true)
  expect(adaptiveInflight).toEqual({
    configuredLimit: 35,
    cooldownUntil: new Date(startMs + 60 * secondMs).toISOString(),
    decreaseCount: 1,
    effectiveLimit: 17,
    lastRateLimitedAt: new Date(startMs).toISOString(),
    rateLimitBackoffActive: true,
  })
  expect(getEffectiveLimit(startMs + 59_999)).toBe(17)
  expect(getCodexConnectionRateLimitCooldownRemainingMs(key, startMs + 10 * secondMs)).toBe(50 * secondMs)
})

test('repeated rate limits halve down to a floor of 2 while the cooldown doubles up to 10 minutes', () => {
  const steps = [0, 1, 2, 3, 4, 5].map((index) => {
    const nowMs = startMs + index * secondMs
    const {adaptiveInflight} = recordRateLimit({nowMs})

    return {
      cooldownMs: Date.parse(adaptiveInflight.cooldownUntil ?? '') - nowMs,
      effectiveLimit: adaptiveInflight.effectiveLimit,
    }
  })

  expect(steps).toEqual([
    {cooldownMs: 60_000, effectiveLimit: 17},
    {cooldownMs: 120_000, effectiveLimit: 8},
    {cooldownMs: 240_000, effectiveLimit: 4},
    {cooldownMs: 480_000, effectiveLimit: 2},
    {cooldownMs: 600_000, effectiveLimit: 2},
    {cooldownMs: 600_000, effectiveLimit: 2},
  ])
})

test('a rate limit from a turn started before the last decrease does not halve again', () => {
  recordRateLimit({nowMs: startMs})

  const {adaptiveInflight, decreased} = recordRateLimit({nowMs: startMs + secondMs, requestStartedAtMs: startMs - 1})

  expect(decreased).toBe(false)
  expect(adaptiveInflight).toMatchObject({
    cooldownUntil: new Date(startMs + 60 * secondMs).toISOString(),
    decreaseCount: 1,
    effectiveLimit: 17,
    lastRateLimitedAt: new Date(startMs + secondMs).toISOString(),
  })
})

test('after the cooldown with a success the limit ramps up by 2 per minute back to the configured limit', () => {
  recordRateLimit({nowMs: startMs})
  recordCodexConnectionSuccess({key, nowMs: startMs + 30 * secondMs})

  const cooldownEndMs = startMs + 60 * secondMs
  const rampLimits = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((minute) => {
    return getEffectiveLimit(cooldownEndMs + minute * minuteMs)
  })

  expect(getEffectiveLimit(cooldownEndMs - 1)).toBe(17)
  expect(rampLimits).toEqual([19, 21, 23, 25, 27, 29, 31, 33, 35, 35])
  expect(isCodexConnectionRateLimitBackoffActive(key, cooldownEndMs + 7 * minuteMs)).toBe(true)
  expect(isCodexConnectionRateLimitBackoffActive(key, cooldownEndMs + 8 * minuteMs)).toBe(false)
  expect(getCodexConnectionTurnTimeoutMs(key, cooldownEndMs + 8 * minuteMs)).toBe(900_000)
})

test('without a success after the decrease the limit stays down after the cooldown', () => {
  recordRateLimit({nowMs: startMs})

  expect(getEffectiveLimit(startMs + 10 * minuteMs)).toBe(17)
  expect(getCodexConnectionNextLimitIncreaseAtMs(key, startMs + 10 * minuteMs)).toBeNull()

  recordCodexConnectionSuccess({key, nowMs: startMs + 10 * minuteMs})

  expect(getEffectiveLimit(startMs + 10 * minuteMs)).toBe(19)
  expect(getCodexConnectionNextLimitIncreaseAtMs(key, startMs + 10 * minuteMs)).toBe(startMs + 11 * minuteMs)
})

test('a rate limit during the ramp halves from the ramped limit and doubles the cooldown', () => {
  recordRateLimit({nowMs: startMs})
  recordCodexConnectionSuccess({key, nowMs: startMs + secondMs})

  const rampedAtMs = startMs + 60 * secondMs + 2 * minuteMs
  const rampedLimit = getEffectiveLimit(rampedAtMs)
  const {adaptiveInflight} = recordRateLimit({nowMs: rampedAtMs})

  expect(rampedLimit).toBe(23)
  expect(adaptiveInflight).toMatchObject({
    cooldownUntil: new Date(rampedAtMs + 120 * secondMs).toISOString(),
    decreaseCount: 2,
    effectiveLimit: 11,
  })
})

test('a full recovery resets the cooldown so the next rate limit starts at 60 s again', () => {
  recordRateLimit({nowMs: startMs})
  recordRateLimit({nowMs: startMs + secondMs})
  recordCodexConnectionSuccess({key, nowMs: startMs + 2 * secondMs})

  const recoveredAtMs = startMs + 60 * minuteMs
  const {adaptiveInflight} = recordRateLimit({nowMs: recoveredAtMs})

  expect(adaptiveInflight).toMatchObject({
    cooldownUntil: new Date(recoveredAtMs + 60 * secondMs).toISOString(),
    decreaseCount: 1,
    effectiveLimit: 17,
  })
})

test('a configured limit change resets the backoff to the new limit', () => {
  recordRateLimit({nowMs: startMs})

  expect(getCodexConnectionAdaptiveInflight({configuredLimit: 10, key, nowMs: startMs + secondMs})).toEqual({
    configuredLimit: 10,
    cooldownUntil: null,
    decreaseCount: 0,
    effectiveLimit: 10,
    lastRateLimitedAt: null,
    rateLimitBackoffActive: false,
  })
  expect(recordRateLimit({configuredLimit: 10, nowMs: startMs + 2 * secondMs}).adaptiveInflight).toMatchObject({
    cooldownUntil: new Date(startMs + 62 * secondMs).toISOString(),
    decreaseCount: 1,
    effectiveLimit: 5,
  })
})

test('a provider retry-after hint holds the cooldown longer, capped at 10 minutes', () => {
  const hinted = recordRateLimit({nowMs: startMs, retryAfterAt: new Date(startMs + 5 * minuteMs)})

  resetCodexRateLimitBackoffForTests()

  const capped = recordRateLimit({nowMs: startMs, retryAfterAt: new Date(startMs + 2 * 60 * minuteMs)})

  expect(hinted.adaptiveInflight.cooldownUntil).toBe(new Date(startMs + 5 * minuteMs).toISOString())
  expect(capped.adaptiveInflight.cooldownUntil).toBe(
    new Date(startMs + codexRateLimitBackoffConstants.cooldownMaxMs).toISOString(),
  )
})

test('the shorter turn timeout applies only while the connection is in backoff', () => {
  recordRateLimit({nowMs: startMs})

  expect(getCodexConnectionTurnTimeoutMs(key, startMs + secondMs)).toBe(180_000)
  expect(getCodexConnectionTurnTimeoutMs('other-connection', startMs + secondMs)).toBe(900_000)
})

test('a configured limit below the floor never raises the effective limit', () => {
  expect(recordRateLimit({configuredLimit: 1, nowMs: startMs}).adaptiveInflight.effectiveLimit).toBe(1)
})
