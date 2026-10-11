import {describe, expect, test} from 'bun:test'

import {
  getArticleCapDefaults,
  getDeadlineDefaults,
  getDefaultPickDateTime,
  getServerClockOffsetMs,
  getStopAtFromParts,
  getStopAtMinuteOptions,
  getTokenBudgetDefaults,
} from './jobStopConditionDefaults.ts'

describe('article cap defaults', () => {
  test('offers the powers of ten up to the project size and above the admitted count', () => {
    expect(getArticleCapDefaults({admittedArticleCount: 0, articleCount: 1_500, humanJudgedArticleCount: 0})).toEqual([
      {disabled: false, label: '100 articles', value: 100},
      {disabled: false, label: '1,000 articles', value: 1_000},
    ])
    expect(
      getArticleCapDefaults({admittedArticleCount: 100, articleCount: 1_000_000, humanJudgedArticleCount: 0}).map(
        (item) => {
          return item.value
        },
      ),
    ).toEqual([1_000, 10_000, 100_000, 1_000_000])
    expect(getArticleCapDefaults({admittedArticleCount: 0, articleCount: 99, humanJudgedArticleCount: 0})).toEqual([])
  })

  test('adds the human-judged article count and disables it once that many are admitted', () => {
    expect(
      getArticleCapDefaults({admittedArticleCount: 40, articleCount: 1_500, humanJudgedArticleCount: 412}).at(-1),
    ).toEqual({disabled: false, label: 'Human-judged articles (412)', value: 412})
    expect(
      getArticleCapDefaults({admittedArticleCount: 412, articleCount: 1_500, humanJudgedArticleCount: 412}),
    ).toEqual([
      {disabled: false, label: '1,000 articles', value: 1_000},
      {disabled: true, label: 'Human-judged articles (412) (reached)', value: 412},
    ])
    expect(getArticleCapDefaults({admittedArticleCount: 0, articleCount: 50, humanJudgedArticleCount: 0})).toEqual([])
  })
})

describe('token budget defaults', () => {
  test('offers the budgets above the current total', () => {
    expect(
      getTokenBudgetDefaults({totalTokens: 0}).map((item) => {
        return item.label
      }),
    ).toEqual(['1 M tokens', '10 M tokens', '100 M tokens', '1 B tokens', '10 B tokens'])
    expect(getTokenBudgetDefaults({totalTokens: 10_000_000})).toEqual([
      {disabled: false, label: '100 M tokens', value: 100_000_000},
      {disabled: false, label: '1 B tokens', value: 1_000_000_000},
      {disabled: false, label: '10 B tokens', value: 10_000_000_000},
    ])
    expect(getTokenBudgetDefaults({totalTokens: 10_000_000_000})).toEqual([])
  })
})

describe('deadline defaults', () => {
  test('computes the quick picks from now', () => {
    const now = new Date(2026, 9, 11, 14, 37, 12)

    expect(
      getDeadlineDefaults(now).map((item) => {
        return [item.label, item.value.toISOString()]
      }),
    ).toEqual([
      ['In 1 hour', new Date(2026, 9, 11, 15, 37, 12).toISOString()],
      ['In 4 hours', new Date(2026, 9, 11, 18, 37, 12).toISOString()],
      ['In 8 hours', new Date(2026, 9, 11, 22, 37, 12).toISOString()],
      ['Tonight 23:00', new Date(2026, 9, 11, 23, 0, 0).toISOString()],
      ['Tomorrow 07:00', new Date(2026, 9, 12, 7, 0, 0).toISOString()],
    ])
  })

  test('omits tonight once 23:00 has passed', () => {
    expect(
      getDeadlineDefaults(new Date(2026, 9, 11, 23, 0, 0)).map((item) => {
        return item.label
      }),
    ).toEqual(['In 1 hour', 'In 4 hours', 'In 8 hours', 'Tomorrow 07:00'])
    expect(
      getDeadlineDefaults(new Date(2026, 9, 11, 22, 59, 59)).map((item) => {
        return item.label
      }),
    ).toContain('Tonight 23:00')
  })

  test('the pick view starts at the next full hour unless a future deadline is set', () => {
    const now = new Date(2026, 9, 11, 14, 37, 12)

    expect(getDefaultPickDateTime(now, null)).toEqual(new Date(2026, 9, 11, 15, 0, 0))
    expect(getDefaultPickDateTime(now, new Date(2026, 9, 12, 9, 30, 0))).toEqual(new Date(2026, 9, 12, 9, 30, 0))
    expect(getDefaultPickDateTime(now, new Date(2026, 9, 10, 9, 30, 0))).toEqual(new Date(2026, 9, 11, 15, 0, 0))
  })

  test('minute options step by five and keep the selected minute', () => {
    expect(getStopAtMinuteOptions(0)).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55])
    expect(getStopAtMinuteOptions(37)).toContain(37)
    expect(getStopAtMinuteOptions(37)).toHaveLength(13)
  })

  test('builds the local date-time from the picked parts and measures the server clock offset', () => {
    expect(getStopAtFromParts({day: 12, hour: 7, minute: 30, month: 10, year: 2026})).toEqual(
      new Date(2026, 9, 12, 7, 30, 0),
    )
    expect(getServerClockOffsetMs('2026-10-11T12:00:05.000Z', Date.parse('2026-10-11T12:00:00.000Z'))).toBe(5_000)
    expect(getServerClockOffsetMs('not a date', 0)).toBe(0)
  })
})
