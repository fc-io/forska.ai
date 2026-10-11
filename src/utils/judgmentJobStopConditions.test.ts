import {describe, expect, test} from 'bun:test'

import {
  getJudgmentJobResumeBlockedMessage,
  getJudgmentJobResumeBlockingStopReason,
  getJudgmentJobStopConditions,
  hasJudgmentJobStopCondition,
  isJudgmentJobArticleCapReached,
  isJudgmentJobDeadlineReached,
  isJudgmentJobStopReason,
  isJudgmentJobTokenBudgetReached,
  type JudgmentJobStopConditions,
} from './judgmentJobStopConditions.ts'

const noConditions: JudgmentJobStopConditions = {
  stopAfterArticles: null,
  stopAfterTotalTokens: null,
  stopAt: null,
  stopWhenHumanAnsweredDone: false,
}
const now = new Date('2026-10-11T12:00:00.000Z')

describe('judgment job stop condition rows', () => {
  test('normalizes DuckDB values and treats invalid or missing values as cleared', () => {
    expect(
      getJudgmentJobStopConditions({
        stopAfterArticles: 2000,
        stopAfterTotalTokens: '5000000000',
        stopAt: '2026-10-11T18:00:00.000Z',
        stopWhenHumanAnsweredDone: true,
      }),
    ).toEqual({
      stopAfterArticles: 2000,
      stopAfterTotalTokens: 5_000_000_000,
      stopAt: new Date('2026-10-11T18:00:00.000Z'),
      stopWhenHumanAnsweredDone: true,
    })
    expect(
      getJudgmentJobStopConditions({
        stopAfterArticles: 0,
        stopAfterTotalTokens: 'abc',
        stopAt: 'not a date',
        stopWhenHumanAnsweredDone: null,
      }),
    ).toEqual(noConditions)
    expect(getJudgmentJobStopConditions({})).toEqual(noConditions)
    expect(getJudgmentJobStopConditions({stopAfterTotalTokens: BigInt(12)}).stopAfterTotalTokens).toBe(12)
  })

  test('reports whether any condition is active', () => {
    expect(hasJudgmentJobStopCondition(noConditions)).toBe(false)
    expect(hasJudgmentJobStopCondition({...noConditions, stopWhenHumanAnsweredDone: true})).toBe(true)
    expect(hasJudgmentJobStopCondition({...noConditions, stopAt: now})).toBe(true)
  })

  test('recognizes stop reasons', () => {
    expect(isJudgmentJobStopReason('article_cap')).toBe(true)
    expect(isJudgmentJobStopReason('human_answered_done')).toBe(true)
    expect(isJudgmentJobStopReason('paused')).toBe(false)
    expect(isJudgmentJobStopReason(null)).toBe(false)
  })
})

describe('judgment job stop condition boundaries', () => {
  test('the deadline is reached exactly at stop_at', () => {
    expect(isJudgmentJobDeadlineReached(new Date(now.getTime() + 1), now)).toBe(false)
    expect(isJudgmentJobDeadlineReached(now, now)).toBe(true)
    expect(isJudgmentJobDeadlineReached(null, now)).toBe(false)
  })

  test('the token budget is reached when the total equals the budget', () => {
    expect(isJudgmentJobTokenBudgetReached(100, 99)).toBe(false)
    expect(isJudgmentJobTokenBudgetReached(100, 100)).toBe(true)
    expect(isJudgmentJobTokenBudgetReached(100, null)).toBe(false)
    expect(isJudgmentJobTokenBudgetReached(null, 1_000)).toBe(false)
  })

  test('the article cap is reached when the admitted count equals the cap', () => {
    expect(isJudgmentJobArticleCapReached(2000, 1999)).toBe(false)
    expect(isJudgmentJobArticleCapReached(2000, 2000)).toBe(true)
    expect(isJudgmentJobArticleCapReached(2000, null)).toBe(false)
  })
})

describe('resume blocking', () => {
  test('blocks resume for the first satisfied condition and names it in the message', () => {
    const conditions = {
      ...noConditions,
      stopAfterArticles: 10,
      stopAfterTotalTokens: 500,
      stopAt: new Date(now.getTime() - 1),
    }

    expect(
      getJudgmentJobResumeBlockingStopReason({conditions, now, progress: {admittedArticleCount: 10, totalTokens: 500}}),
    ).toBe('deadline')
    expect(
      getJudgmentJobResumeBlockingStopReason({
        conditions: {...conditions, stopAt: null},
        now,
        progress: {admittedArticleCount: 10, totalTokens: 500},
      }),
    ).toBe('token_budget')
    expect(
      getJudgmentJobResumeBlockingStopReason({
        conditions: {...conditions, stopAt: null},
        now,
        progress: {admittedArticleCount: 10, totalTokens: 499},
      }),
    ).toBe('article_cap')
    expect(getJudgmentJobResumeBlockedMessage('article_cap')).toBe(
      'Raise or clear the article cap stop condition to resume',
    )
    expect(getJudgmentJobResumeBlockedMessage('token_budget')).toBe(
      'Raise or clear the token budget stop condition to resume',
    )
  })

  test('the human-answered condition never blocks resume because the refill pass decides it', () => {
    expect(
      getJudgmentJobResumeBlockingStopReason({
        conditions: {...noConditions, stopWhenHumanAnsweredDone: true},
        now,
        progress: {admittedArticleCount: null, totalTokens: null},
      }),
    ).toBeNull()
  })

  test('allows resume below every limit', () => {
    expect(
      getJudgmentJobResumeBlockingStopReason({
        conditions: {
          stopAfterArticles: 11,
          stopAfterTotalTokens: 501,
          stopAt: new Date(now.getTime() + 1),
          stopWhenHumanAnsweredDone: false,
        },
        now,
        progress: {admittedArticleCount: 10, totalTokens: 500},
      }),
    ).toBeNull()
  })
})
