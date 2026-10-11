import {addDays, addHours, set, startOfHour} from 'date-fns'

import {formatNumber} from '../../jobsPageShared'

export type StopConditionCountDefault = {disabled: boolean; label: string; value: number}

export type StopConditionDeadlineDefault = {label: string; value: Date}

export type StopConditionDefaultsData = {
  admittedArticleCount: number
  articleCount: number
  humanJudgedArticleCount: number
  serverNow: string
  totalTokens: number
}

const articleCapPowers = [100, 1_000, 10_000, 100_000, 1_000_000]
const tokenBudgetDefaults = [
  {label: '1 M tokens', value: 1_000_000},
  {label: '10 M tokens', value: 10_000_000},
  {label: '100 M tokens', value: 100_000_000},
  {label: '1 B tokens', value: 1_000_000_000},
  {label: '10 B tokens', value: 10_000_000_000},
]
const stopAtMinuteStep = 5

export const getArticleCapDefaults = ({
  admittedArticleCount,
  articleCount,
  humanJudgedArticleCount,
}: {
  admittedArticleCount: number
  articleCount: number
  humanJudgedArticleCount: number
}): StopConditionCountDefault[] => {
  const powerDefaults = articleCapPowers
    .filter((value) => {
      return value <= articleCount && value > admittedArticleCount
    })
    .map((value) => {
      return {disabled: false, label: `${formatNumber(value)} articles`, value}
    })
  const isHumanJudgedReached = humanJudgedArticleCount <= admittedArticleCount
  const humanJudgedDefaults =
    humanJudgedArticleCount > 0
      ? [
          {
            disabled: isHumanJudgedReached,
            label: `Human-judged articles (${formatNumber(humanJudgedArticleCount)})${isHumanJudgedReached ? ' (reached)' : ''}`,
            value: humanJudgedArticleCount,
          },
        ]
      : []

  return [...powerDefaults, ...humanJudgedDefaults]
}

export const getTokenBudgetDefaults = ({totalTokens}: {totalTokens: number}): StopConditionCountDefault[] => {
  return tokenBudgetDefaults
    .filter((item) => {
      return item.value > totalTokens
    })
    .map((item) => {
      return {...item, disabled: false}
    })
}

export const getDeadlineDefaults = (now: Date): StopConditionDeadlineDefault[] => {
  const tonight = set(now, {hours: 23, milliseconds: 0, minutes: 0, seconds: 0})
  const tonightDefaults = tonight.getTime() > now.getTime() ? [{label: 'Tonight 23:00', value: tonight}] : []

  return [
    {label: 'In 1 hour', value: addHours(now, 1)},
    {label: 'In 4 hours', value: addHours(now, 4)},
    {label: 'In 8 hours', value: addHours(now, 8)},
    ...tonightDefaults,
    {label: 'Tomorrow 07:00', value: set(addDays(now, 1), {hours: 7, milliseconds: 0, minutes: 0, seconds: 0})},
  ]
}

export const getServerClockOffsetMs = (serverNow: string, receivedAtMs: number): number => {
  const serverNowMs = new Date(serverNow).getTime()

  return Number.isFinite(serverNowMs) ? serverNowMs - receivedAtMs : 0
}

export const getDefaultPickDateTime = (now: Date, stopAt: Date | null): Date => {
  return stopAt !== null && stopAt.getTime() > now.getTime() ? stopAt : startOfHour(addHours(now, 1))
}

export const getStopAtHourOptions = (): number[] => {
  return Array.from({length: 24}, (_value, hour) => {
    return hour
  })
}

export const getStopAtMinuteOptions = (selectedMinute: number): number[] => {
  const stepMinutes = Array.from({length: 60 / stopAtMinuteStep}, (_value, index) => {
    return index * stopAtMinuteStep
  })

  return Array.from(new Set([...stepMinutes, selectedMinute])).sort((left, right) => {
    return left - right
  })
}

export const getStopAtFromParts = ({
  day,
  hour,
  minute,
  month,
  year,
}: {
  day: number
  hour: number
  minute: number
  month: number
  year: number
}): Date => {
  return new Date(year, month - 1, day, hour, minute, 0, 0)
}
