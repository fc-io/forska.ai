import {describe, expect, test} from 'bun:test'

import {
  getJudgmentJobStopConditionAssignments,
  mergeJudgmentJobStopConditions,
  parseJudgmentJobStopConditionUpdate,
} from './judgmentJobStopConditionInput.ts'

const now = new Date('2026-10-11T10:00:00.000Z')

describe('stop condition PATCH input', () => {
  test('accepts positive integers, a future ISO stop_at, booleans and null clears', () => {
    expect(
      parseJudgmentJobStopConditionUpdate(
        {
          stopAfterArticles: 2000,
          stopAfterTotalTokens: 5_000_000_000,
          stopAt: '2026-10-11T18:00:00.000Z',
          stopWhenHumanAnsweredDone: true,
        },
        now,
      ),
    ).toEqual({
      ok: true,
      value: {
        stopAfterArticles: 2000,
        stopAfterTotalTokens: 5_000_000_000,
        stopAt: new Date('2026-10-11T18:00:00.000Z'),
        stopWhenHumanAnsweredDone: true,
      },
    })
    expect(
      parseJudgmentJobStopConditionUpdate(
        {stopAfterArticles: null, stopAfterTotalTokens: null, stopAt: null, stopWhenHumanAnsweredDone: null},
        now,
      ),
    ).toEqual({
      ok: true,
      value: {stopAfterArticles: null, stopAfterTotalTokens: null, stopAt: null, stopWhenHumanAnsweredDone: false},
    })
  })

  test('leaves omitted fields out of the update', () => {
    expect(parseJudgmentJobStopConditionUpdate({}, now)).toEqual({ok: true, value: {}})
    expect(parseJudgmentJobStopConditionUpdate({stopAfterArticles: 1}, now)).toEqual({
      ok: true,
      value: {stopAfterArticles: 1},
    })
  })

  test.each([
    [{stopAfterArticles: 0}, 'stopAfterArticles must be a positive integer or null'],
    [{stopAfterArticles: -1}, 'stopAfterArticles must be a positive integer or null'],
    [{stopAfterArticles: 1.5}, 'stopAfterArticles must be a positive integer or null'],
    [{stopAfterArticles: '12'}, 'stopAfterArticles must be a positive integer or null'],
    [{stopAfterArticles: 2_147_483_648}, 'stopAfterArticles must be a positive integer or null'],
    [{stopAfterTotalTokens: 0}, 'stopAfterTotalTokens must be a positive integer or null'],
    [{stopAfterTotalTokens: true}, 'stopAfterTotalTokens must be a positive integer or null'],
    [{stopAt: '2026-10-11T10:00:00.000Z'}, 'stopAt must be a future ISO date-time or null'],
    [{stopAt: '2026-10-11T09:59:59.999Z'}, 'stopAt must be a future ISO date-time or null'],
    [{stopAt: 'tomorrow 07:00'}, 'stopAt must be a future ISO date-time or null'],
    [{stopAt: 1_791_800_000_000}, 'stopAt must be a future ISO date-time or null'],
    [{stopWhenHumanAnsweredDone: 'yes'}, 'stopWhenHumanAnsweredDone must be a boolean or null'],
  ])('rejects %p', (body, error) => {
    expect(parseJudgmentJobStopConditionUpdate(body, now)).toEqual({error, ok: false})
  })

  test('accepts a stop_at one millisecond in the future', () => {
    expect(parseJudgmentJobStopConditionUpdate({stopAt: '2026-10-11T10:00:00.001Z'}, now)).toEqual({
      ok: true,
      value: {stopAt: new Date('2026-10-11T10:00:00.001Z')},
    })
  })

  test('builds SQL assignments only for supplied fields', () => {
    expect(getJudgmentJobStopConditionAssignments({})).toEqual([])
    expect(
      getJudgmentJobStopConditionAssignments({
        stopAfterArticles: null,
        stopAt: new Date('2026-10-11T18:00:00.000Z'),
        stopWhenHumanAnsweredDone: true,
      }),
    ).toEqual([
      'stop_after_articles = NULL',
      "stop_at = TIMESTAMPTZ '2026-10-11T18:00:00.000Z'",
      'stop_when_human_answered_done = TRUE',
    ])
  })

  test('merges an update over the stored conditions', () => {
    expect(
      mergeJudgmentJobStopConditions(
        {stopAfterArticles: 10, stopAfterTotalTokens: 20, stopAt: null, stopWhenHumanAnsweredDone: true},
        {stopAfterArticles: null, stopAfterTotalTokens: 30},
      ),
    ).toEqual({stopAfterArticles: null, stopAfterTotalTokens: 30, stopAt: null, stopWhenHumanAnsweredDone: true})
  })
})
