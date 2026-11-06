import {describe, expect, test} from 'bun:test'

import {parseCodexRateLimitReadings} from './codexRateLimitQuota.ts'

const context = {observedAt: new Date('2026-11-06T12:00:00.000Z'), providerConnectionId: 'connection-codex'}
const primaryResetsAtSeconds = 1_762_444_800
const secondaryResetsAtSeconds = 1_762_963_200

const buildSnapshot = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
  return {
    credits: null,
    limitId: 'codex',
    limitName: null,
    planType: 'pro',
    primary: {resetsAt: primaryResetsAtSeconds, usedPercent: 42, windowDurationMins: 300},
    rateLimitReachedType: null,
    secondary: {resetsAt: secondaryResetsAtSeconds, usedPercent: 7.5, windowDurationMins: 10_080},
    ...overrides,
  }
}

const getLimitKinds = (readings: ReturnType<typeof parseCodexRateLimitReadings>): string[] => {
  return readings.map((reading) => {
    return reading.limitKind
  })
}

describe('parseCodexRateLimitReadings', () => {
  test('reads primary and secondary windows from a single-bucket response', () => {
    const snapshot = buildSnapshot()
    const readings = parseCodexRateLimitReadings({rateLimits: snapshot, rateLimitsByLimitId: null}, context)

    expect(readings).toEqual([
      {
        isActive: null,
        limitKind: 'codex:primary',
        observedAt: context.observedAt,
        providerConnectionId: 'connection-codex',
        providerKind: 'codex',
        rawJson: {resetsAt: primaryResetsAtSeconds, usedPercent: 42, windowDurationMins: 300},
        resetsAt: new Date(primaryResetsAtSeconds * 1000),
        scopeJson: {
          limitId: 'codex',
          limitName: null,
          planType: 'pro',
          rateLimitReachedType: null,
          windowDurationMins: 300,
        },
        utilizationPercent: 42,
      },
      {
        isActive: null,
        limitKind: 'codex:secondary',
        observedAt: context.observedAt,
        providerConnectionId: 'connection-codex',
        providerKind: 'codex',
        rawJson: {resetsAt: secondaryResetsAtSeconds, usedPercent: 7.5, windowDurationMins: 10_080},
        resetsAt: new Date(secondaryResetsAtSeconds * 1000),
        scopeJson: {
          limitId: 'codex',
          limitName: null,
          planType: 'pro',
          rateLimitReachedType: null,
          windowDurationMins: 10_080,
        },
        utilizationPercent: 7.5,
      },
    ])
  })

  test('reads only rateLimitsByLimitId when the response has several buckets', () => {
    const codexSnapshot = buildSnapshot()
    const otherSnapshot = buildSnapshot({
      limitId: 'codex_other',
      limitName: 'Other model',
      primary: {resetsAt: primaryResetsAtSeconds, usedPercent: 3, windowDurationMins: 300},
      secondary: null,
    })
    const readings = parseCodexRateLimitReadings(
      {rateLimits: codexSnapshot, rateLimitsByLimitId: {codex: codexSnapshot, codex_other: otherSnapshot}},
      context,
    )

    expect(getLimitKinds(readings)).toEqual(['codex:primary', 'codex:secondary', 'codex_other:primary'])
    expect(readings[2]?.scopeJson).toEqual({
      limitId: 'codex_other',
      limitName: 'Other model',
      planType: 'pro',
      rateLimitReachedType: null,
      windowDurationMins: 300,
    })
  })

  test('skips a null window', () => {
    const readings = parseCodexRateLimitReadings(
      {rateLimits: buildSnapshot({primary: null}), rateLimitsByLimitId: null},
      context,
    )

    expect(getLimitKinds(readings)).toEqual(['codex:secondary'])
  })

  test('skips a window without a numeric usedPercent and keeps a null resetsAt', () => {
    const readings = parseCodexRateLimitReadings(
      {
        rateLimits: buildSnapshot({
          primary: {resetsAt: null, usedPercent: 0, windowDurationMins: null},
          secondary: {resetsAt: secondaryResetsAtSeconds, usedPercent: '7', windowDurationMins: 10_080},
        }),
        rateLimitsByLimitId: null,
      },
      context,
    )

    expect(getLimitKinds(readings)).toEqual(['codex:primary'])
    expect(readings[0]?.resetsAt).toBeNull()
    expect(readings[0]?.utilizationPercent).toBe(0)
  })

  test('falls back to the codex limit id when limitId is missing or blank', () => {
    expect(
      getLimitKinds(
        parseCodexRateLimitReadings({rateLimits: buildSnapshot({limitId: null}), rateLimitsByLimitId: null}, context),
      ),
    ).toEqual(['codex:primary', 'codex:secondary'])
    expect(
      getLimitKinds(
        parseCodexRateLimitReadings({rateLimits: buildSnapshot({limitId: ' '}), rateLimitsByLimitId: null}, context),
      ),
    ).toEqual(['codex:primary', 'codex:secondary'])
  })

  test('returns no rows for a response that is not an object', () => {
    expect(parseCodexRateLimitReadings(null, context)).toEqual([])
    expect(parseCodexRateLimitReadings('rate limits', context)).toEqual([])
    expect(parseCodexRateLimitReadings([buildSnapshot()], context)).toEqual([])
  })

  test('returns no rows when rateLimits is missing', () => {
    expect(parseCodexRateLimitReadings({rateLimitsByLimitId: null}, context)).toEqual([])
  })
})
