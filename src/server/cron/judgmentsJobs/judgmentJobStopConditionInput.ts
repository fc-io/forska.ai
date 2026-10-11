import {type as arktype} from 'arktype'

import {
  type JudgmentJobStopConditions,
  maxJudgmentJobStopAfterArticles,
  maxJudgmentJobStopAfterTotalTokens,
} from '../../../utils/judgmentJobStopConditions.ts'
import {getSqlLiteral} from '../../services/appQueryHelpers.ts'

export type JudgmentJobStopConditionUpdate = Partial<JudgmentJobStopConditions>

type StopConditionBody = {
  stopAfterArticles?: unknown
  stopAfterTotalTokens?: unknown
  stopAt?: unknown
  stopWhenHumanAnsweredDone?: unknown
}

type ParseResult<T> = {error: string; ok: false} | {ok: true; value: T}

const stopAfterArticlesShape = arktype(`null | 0 < number.integer <= ${maxJudgmentJobStopAfterArticles}`)
const stopAfterTotalTokensShape = arktype(`null | 0 < number.integer <= ${maxJudgmentJobStopAfterTotalTokens}`)
const stopWhenHumanAnsweredDoneShape = arktype('null | boolean')
const stopAtShape = arktype('null | string')

const parseCount = (
  value: unknown,
  shape: (input: unknown) => unknown,
  fieldName: string,
): ParseResult<number | null | undefined> => {
  return value === undefined
    ? {ok: true, value: undefined}
    : shape(value) instanceof arktype.errors
      ? {error: `${fieldName} must be a positive integer or null`, ok: false}
      : {ok: true, value: value as number | null}
}

const parseStopWhenHumanAnsweredDone = (value: unknown): ParseResult<boolean | undefined> => {
  return value === undefined
    ? {ok: true, value: undefined}
    : stopWhenHumanAnsweredDoneShape(value) instanceof arktype.errors
      ? {error: 'stopWhenHumanAnsweredDone must be a boolean or null', ok: false}
      : {ok: true, value: value === true}
}

const getFutureDate = (value: string, now: Date): Date | null => {
  const date = /^\d{4}-\d{2}-\d{2}T/u.test(value) ? new Date(value) : null

  return date && Number.isFinite(date.getTime()) && date.getTime() > now.getTime() ? date : null
}

const parseStopAt = (value: unknown, now: Date): ParseResult<Date | null | undefined> => {
  const futureDate = typeof value === 'string' ? getFutureDate(value, now) : null

  return value === undefined || value === null
    ? {ok: true, value: value}
    : stopAtShape(value) instanceof arktype.errors || futureDate === null
      ? {error: 'stopAt must be a future ISO date-time or null', ok: false}
      : {ok: true, value: futureDate}
}

const getDefinedEntries = (update: Record<string, unknown>): JudgmentJobStopConditionUpdate => {
  return Object.fromEntries(
    Object.entries(update).filter(([, value]) => {
      return value !== undefined
    }),
  ) as JudgmentJobStopConditionUpdate
}

export const parseJudgmentJobStopConditionUpdate = (
  body: StopConditionBody,
  now: Date,
): ParseResult<JudgmentJobStopConditionUpdate> => {
  const results = {
    stopAfterArticles: parseCount(body.stopAfterArticles, stopAfterArticlesShape, 'stopAfterArticles'),
    stopAfterTotalTokens: parseCount(body.stopAfterTotalTokens, stopAfterTotalTokensShape, 'stopAfterTotalTokens'),
    stopAt: parseStopAt(body.stopAt, now),
    stopWhenHumanAnsweredDone: parseStopWhenHumanAnsweredDone(body.stopWhenHumanAnsweredDone),
  }
  const failure = Object.values(results).find((result) => {
    return !result.ok
  })

  return failure && !failure.ok
    ? failure
    : {
        ok: true,
        value: getDefinedEntries(
          Object.fromEntries(
            Object.entries(results).map(([key, result]) => {
              return [key, result.ok ? result.value : undefined]
            }),
          ),
        ),
      }
}

export const getJudgmentJobStopConditionAssignments = (update: JudgmentJobStopConditionUpdate): string[] => {
  const assignments: Array<[keyof JudgmentJobStopConditions, string]> = [
    ['stopAfterArticles', 'stop_after_articles'],
    ['stopAfterTotalTokens', 'stop_after_total_tokens'],
    ['stopAt', 'stop_at'],
    ['stopWhenHumanAnsweredDone', 'stop_when_human_answered_done'],
  ]

  return assignments.flatMap(([key, columnName]) => {
    return key in update ? [`${columnName} = ${getSqlLiteral(update[key] ?? null)}`] : []
  })
}

export const mergeJudgmentJobStopConditions = (
  current: JudgmentJobStopConditions,
  update: JudgmentJobStopConditionUpdate,
): JudgmentJobStopConditions => {
  return {...current, ...update}
}
