import {and, eq, gte, inArray, lt} from 'drizzle-orm'

import {judgmentsJobs, tokenUse} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'
import {aggregateTokenTimelineRows, type TokenTimelineInterval} from './tokensRoutesTimelineUtils.ts'

type TimelineParams = {projectId: string; interval: TokenTimelineInterval; startDate: string; endDate: string}

export const tokensRoutesGetTimeline = async ({projectId, interval, startDate, endDate}: TimelineParams) => {
  const db = getDatabase()

  const projectJobs = await db
    .select({id: judgmentsJobs.id})
    .from(judgmentsJobs)
    .where(eq(judgmentsJobs.projectId, projectId))

  const jobIds = projectJobs.map((job) => {
    return job.id
  })

  if (jobIds.length === 0) {
    return {success: true, data: []}
  }

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
        inArray(tokenUse.judgmentsJobId, jobIds),
        gte(tokenUse.createdAt, new Date(startDate)),
        lt(tokenUse.createdAt, new Date(endDate)),
      ),
    )
  const {completeData} = aggregateTokenTimelineRows({rows: result, interval, startDate, endDate})

  return {success: true, data: completeData}
}
