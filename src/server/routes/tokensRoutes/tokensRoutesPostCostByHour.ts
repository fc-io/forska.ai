import type {Context} from 'elysia'

import {getProviderCostByHour, type ProviderCostQuery} from '../../services/providerCostQueryService.ts'

export type CostByHourBody = {from?: string; jobId?: string; to?: string}

type CostByHourQueryResult = {error: string; query: null} | {error: null; query: ProviderCostQuery}

const getOptionalDate = (value: string | undefined): Date | null | 'invalid' => {
  const date = value === undefined ? null : new Date(value)

  return date === null ? null : Number.isFinite(date.getTime()) ? date : 'invalid'
}

const getTrimmedJobId = (value: string | undefined): string | null => {
  const trimmed = value?.trim() ?? ''

  return trimmed === '' ? null : trimmed
}

export const getCostByHourQuery = (body: CostByHourBody): CostByHourQueryResult => {
  const from = getOptionalDate(body.from)
  const to = getOptionalDate(body.to)

  return from === 'invalid' || to === 'invalid'
    ? {error: 'from and to must be ISO 8601 timestamps', query: null}
    : from !== null && to !== null && from.getTime() >= to.getTime()
      ? {error: 'from must be before to', query: null}
      : {error: null, query: {from, jobId: getTrimmedJobId(body.jobId), to}}
}

export const tokensRoutesPostCostByHour = async ({body, set}: {body: CostByHourBody; set: Context['set']}) => {
  const parsed = getCostByHourQuery(body)

  if (parsed.query === null) {
    set.status = 400
    return {data: null, error: parsed.error}
  }

  return {data: await getProviderCostByHour({query: parsed.query}), error: null}
}
