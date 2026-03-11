import {and, gte, isNotNull, lt} from 'drizzle-orm'

import {tokenUse} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'
import {aggregateTokenTimelineRows, type TokenTimelineInterval} from './tokensRoutesTimelineUtils.ts'

type TimelineParams = {interval: TokenTimelineInterval; startDate: string; endDate: string}

export const tokensRoutesGetTimelineAllJobs = async ({interval, startDate, endDate}: TimelineParams) => {
  const db = getDatabase()

  const result = await db
    .select({
      createdAt: tokenUse.createdAt,
      totalPromptTokens: tokenUse.totalPromptTokens,
      totalCompletionTokens: tokenUse.totalCompletionTokens,
      totalTokens: tokenUse.totalTokens,
      requests: tokenUse.requests,
      totalSuccessPromptTokens: tokenUse.totalSuccessPromptTokens,
      totalSuccessCompletionTokens: tokenUse.totalSuccessCompletionTokens,
      totalSuccessTokens: tokenUse.totalSuccessTokens,
      totalFailedTokens: tokenUse.totalFailedTokens,
    })
    .from(tokenUse)
    .where(
      and(
        isNotNull(tokenUse.judgmentsJobId),
        gte(tokenUse.createdAt, new Date(startDate)),
        lt(tokenUse.createdAt, new Date(endDate)),
      ),
    )
  const {completeData} = aggregateTokenTimelineRows({rows: result, interval, startDate, endDate})

  return {success: true, data: completeData}
}
