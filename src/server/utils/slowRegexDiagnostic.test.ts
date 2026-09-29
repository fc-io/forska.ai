import {afterEach, expect, test} from 'bun:test'

import {getInstalledRegexTest, installSlowRegexDiagnostic, slowRegexThresholdMs} from './slowRegexDiagnostic.ts'

type LoggedEvent = Parameters<
  NonNullable<NonNullable<Parameters<typeof installSlowRegexDiagnostic>[0]>['writeLogEvent']>
>[0]

const originalTest = getInstalledRegexTest()
const uninstalls: Array<() => void> = []

const getClock = (readings: readonly number[]) => {
  const remaining = [...readings]

  return () => {
    return remaining.shift() ?? 0
  }
}

const install = (options: {readings: readonly number[]; thresholdMs?: number; writeLogEvent?: () => boolean}) => {
  const events: LoggedEvent[] = []
  const uninstall = installSlowRegexDiagnostic({
    nowMs: getClock(options.readings),
    thresholdMs: options.thresholdMs,
    writeLogEvent:
      options.writeLogEvent
      ?? ((event) => {
        events.push(event)

        return true
      }),
  })

  if (uninstall !== null) {
    uninstalls.push(uninstall)
  }

  return {events, uninstall}
}

afterEach(() => {
  uninstalls.splice(0).forEach((uninstall) => {
    uninstall()
  })
})

test('a test call that blocks the thread is logged with its regex, its input and its caller', () => {
  const {events} = install({readings: [0, slowRegexThresholdMs]})
  const text = `${'a'.repeat(500)}needle${'b'.repeat(300)}`

  expect(/needle/iu.test(text)).toBe(true)

  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({
    attrs: {
      durationMs: slowRegexThresholdMs,
      flags: 'iu',
      inputHead: 'a'.repeat(400),
      inputLength: text.length,
      inputTail: 'b'.repeat(200),
      result: true,
      source: 'needle',
    },
    event: 'diagnostic.slow-regex',
    severity: 'WARN',
  })
  expect(String(events[0]?.attrs?.stack)).toContain('slowRegexDiagnostic.test.ts')
})

test('a test call below the threshold is not logged and keeps the regex position', () => {
  const {events} = install({readings: [0, slowRegexThresholdMs - 1, 0, 0, 0, 0]})
  const regex = /b/gu

  expect(regex.test('abab')).toBe(true)
  expect(regex.lastIndex).toBe(2)
  expect(regex.test('abab')).toBe(true)
  expect(regex.lastIndex).toBe(4)
  expect(regex.test('abab')).toBe(false)
  expect(events).toEqual([])
})

test('installing again does not wrap the wrapper', () => {
  const first = install({readings: [0, 5, 0, 5], thresholdMs: 5})
  const second = install({readings: [0, 5], thresholdMs: 5})

  expect(second.uninstall).toBeNull()
  expect(/a/u.test('a')).toBe(true)
  expect(first.events).toHaveLength(1)
  expect(second.events).toEqual([])
})

test('uninstalling restores the original test and allows a later install', () => {
  const {uninstall} = install({readings: []})

  expect(getInstalledRegexTest()).not.toBe(originalTest)
  uninstall?.()
  expect(getInstalledRegexTest()).toBe(originalTest)

  const {events} = install({readings: [0, 7], thresholdMs: 7})

  expect(/a/u.test('b')).toBe(false)
  expect(events).toHaveLength(1)
  expect(events[0]?.attrs).toMatchObject({result: false})
})

test('a failing log write does not change what the call returns', () => {
  install({
    readings: [0, 1, 0, 1],
    thresholdMs: 1,
    writeLogEvent: () => {
      throw new Error('log sink failed')
    },
  })

  expect(/a/u.test('a')).toBe(true)
  expect(/a/u.test('b')).toBe(false)
})
