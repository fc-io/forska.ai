import {describe, expect, test} from 'bun:test'

import {
  getNextProviderQuotaPollState,
  getProviderQuotaPollDueAtMs,
  initialProviderQuotaPollState,
  isProviderQuotaPollDue,
  type ProviderQuotaPollOutcome,
  type ProviderQuotaPollState,
} from './providerQuotaPollSchedule.ts'

const startMs = 1_762_430_400_000

const getStateAfter = (
  outcome: ProviderQuotaPollOutcome,
  {
    nowMs = startMs,
    retryAfterMs = null,
    state = initialProviderQuotaPollState,
  }: {nowMs?: number; retryAfterMs?: number | null; state?: ProviderQuotaPollState} = {},
): ProviderQuotaPollState => {
  return getNextProviderQuotaPollState({nowMs, outcome, retryAfterMs, state})
}

const getTransientBackoffs = (count: number): number[] => {
  return Array.from({length: count}).reduce<{backoffs: number[]; state: ProviderQuotaPollState}>(
    (accumulator, _value, index) => {
      const state = getStateAfter('transient', {nowMs: startMs + index * 1_000, state: accumulator.state})

      return {backoffs: [...accumulator.backoffs, state.backoffMs], state}
    },
    {backoffs: [], state: initialProviderQuotaPollState},
  ).backoffs
}

describe('getProviderQuotaPollDueAtMs', () => {
  test('makes the first poll due at 0 with and without a running job', () => {
    expect(getProviderQuotaPollDueAtMs({hasRunningJob: true, state: initialProviderQuotaPollState})).toBe(0)
    expect(getProviderQuotaPollDueAtMs({hasRunningJob: false, state: initialProviderQuotaPollState})).toBe(0)
    expect(isProviderQuotaPollDue({hasRunningJob: false, nowMs: 0, state: initialProviderQuotaPollState})).toBe(true)
  })

  test('polls again exactly 60 s after ok while a job is running', () => {
    const state = getStateAfter('ok')

    expect(getProviderQuotaPollDueAtMs({hasRunningJob: true, state})).toBe(startMs + 60_000)
    expect(isProviderQuotaPollDue({hasRunningJob: true, nowMs: startMs + 59_999, state})).toBe(false)
    expect(isProviderQuotaPollDue({hasRunningJob: true, nowMs: startMs + 60_000, state})).toBe(true)
  })

  test('polls again 600 s after ok without a running job', () => {
    const state = getStateAfter('ok')

    expect(getProviderQuotaPollDueAtMs({hasRunningJob: false, state})).toBe(startMs + 600_000)
    expect(isProviderQuotaPollDue({hasRunningJob: false, nowMs: startMs + 599_999, state})).toBe(false)
    expect(isProviderQuotaPollDue({hasRunningJob: false, nowMs: startMs + 600_000, state})).toBe(true)
  })

  test('waits 600 s after auth and unreadable even with a running job', () => {
    const authState = getStateAfter('auth')
    const unreadableState = getStateAfter('unreadable')

    expect(getProviderQuotaPollDueAtMs({hasRunningJob: true, state: authState})).toBe(startMs + 600_000)
    expect(getProviderQuotaPollDueAtMs({hasRunningJob: true, state: unreadableState})).toBe(startMs + 600_000)
    expect(isProviderQuotaPollDue({hasRunningJob: true, nowMs: startMs + 599_999, state: authState})).toBe(false)
    expect(isProviderQuotaPollDue({hasRunningJob: true, nowMs: startMs + 600_000, state: authState})).toBe(true)
  })
})

describe('getNextProviderQuotaPollState', () => {
  test('doubles the transient back-off from 120 s up to the 600 s cap', () => {
    expect(getTransientBackoffs(5)).toEqual([120_000, 240_000, 480_000, 600_000, 600_000])
  })

  test('waits the back-off after transient regardless of a running job', () => {
    const state = getStateAfter('transient')

    expect(getProviderQuotaPollDueAtMs({hasRunningJob: true, state})).toBe(startMs + 120_000)
    expect(getProviderQuotaPollDueAtMs({hasRunningJob: false, state})).toBe(startMs + 120_000)
  })

  test('resets the back-off to 0 after ok', () => {
    const transientState = getStateAfter('transient', {
      state: getStateAfter('transient', {state: getStateAfter('transient')}),
    })
    const okState = getStateAfter('ok', {nowMs: startMs + 1_000, state: transientState})

    expect(transientState.backoffMs).toBe(480_000)
    expect(okState).toEqual({
      backoffMs: 0,
      lastAttemptAtMs: startMs + 1_000,
      lastOutcome: 'ok',
      retryAfterUntilMs: null,
    })
    expect(getStateAfter('transient', {state: okState}).backoffMs).toBe(120_000)
  })

  test('lengthens the due time to retry-after when it exceeds the back-off', () => {
    const state = getStateAfter('transient', {retryAfterMs: 300_000})

    expect(state.retryAfterUntilMs).toBe(startMs + 300_000)
    expect(getProviderQuotaPollDueAtMs({hasRunningJob: true, state})).toBe(startMs + 300_000)
    expect(isProviderQuotaPollDue({hasRunningJob: true, nowMs: startMs + 299_999, state})).toBe(false)
    expect(isProviderQuotaPollDue({hasRunningJob: true, nowMs: startMs + 300_000, state})).toBe(true)
  })

  test('keeps the back-off when retry-after is shorter', () => {
    const state = getStateAfter('transient', {retryAfterMs: 60_000})

    expect(getProviderQuotaPollDueAtMs({hasRunningJob: true, state})).toBe(startMs + 120_000)
  })

  test('clears retry-after on the next non-transient outcome', () => {
    const transientState = getStateAfter('transient', {retryAfterMs: 3_600_000})
    const nextNowMs = startMs + 3_600_000

    const outcomes: ProviderQuotaPollOutcome[] = ['ok', 'auth', 'unreadable']

    expect(
      outcomes.map((outcome) => {
        return getStateAfter(outcome, {nowMs: nextNowMs, retryAfterMs: 3_600_000, state: transientState})
          .retryAfterUntilMs
      }),
    ).toEqual([null, null, null])
    expect(
      getProviderQuotaPollDueAtMs({
        hasRunningJob: true,
        state: getStateAfter('ok', {nowMs: nextNowMs, state: transientState}),
      }),
    ).toBe(nextNowMs + 60_000)
  })

  test('drops an earlier retry-after when the next transient has none', () => {
    const firstState = getStateAfter('transient', {retryAfterMs: 3_600_000})
    const secondState = getStateAfter('transient', {nowMs: startMs + 3_600_000, state: firstState})

    expect(secondState.retryAfterUntilMs).toBeNull()
    expect(getProviderQuotaPollDueAtMs({hasRunningJob: true, state: secondState})).toBe(startMs + 3_600_000 + 240_000)
  })
})
