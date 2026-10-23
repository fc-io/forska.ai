import type {SystemPromptVariant} from '../../../agent/judge/systemPromptVariant.ts'
import {getJudgmentJobUnassessedCountFromServing} from '../../reviewServing/reviewServingJudgmentJobQueueService.ts'
import {getJobContext} from './getJobContext.ts'
import {getProjectMartFreshnessPayload, getProjectMartFreshnessState} from './projectMartFreshness.ts'

type UnassessedCountCacheValue = {value: number; expiresAt: number}
const unassessedCountTTLms = 10_000
const unassessedCountCache = new Map<string, UnassessedCountCacheValue>()

const getUnassessedCountCacheKey = (
  projectId: string,
  projectModelId: string,
  projectDateFrom: Date | null | undefined,
  projectDateTo: Date | null | undefined,
  importRouteIds: string[],
  useTitle: boolean,
  useAbstract: boolean,
  useFulltext: boolean,
  useFulltextNoImages: boolean,
  useMetadata: boolean,
  systemPromptVariant: SystemPromptVariant,
  fullTextStrategyId: string,
  dirtyToken: number | null,
  lastCompletedDirtyToken: number | null,
) => {
  const from = projectDateFrom ? projectDateFrom.toISOString() : ''
  const to = projectDateTo ? projectDateTo.toISOString() : ''
  const routes = importRouteIds.slice().sort().join(',')
  const content = `${useTitle}|${useAbstract}|${useFulltext}|${useFulltextNoImages}|${useMetadata}|${systemPromptVariant}|${fullTextStrategyId}`
  return `${projectId}|${projectModelId}|${from}|${to}|${routes}|${content}|${dirtyToken ?? 'null'}|${lastCompletedDirtyToken ?? 'null'}`
}

export const judgmentsJobsRoutesGetUnassessedCount = async ({query}: {query: {jobId: string}}) => {
  const {projectDateFrom, projectDateTo, importRouteIds, projectModelId, job} = await getJobContext({
    jobId: query.jobId,
  })
  const freshness = await getProjectMartFreshnessState(job.projectId)

  const cacheKey = getUnassessedCountCacheKey(
    job.projectId,
    projectModelId,
    projectDateFrom,
    projectDateTo,
    importRouteIds,
    job.useTitle,
    job.useAbstract,
    job.useFulltext,
    job.useFulltextNoImages,
    job.useMetadata,
    job.systemPromptVariant,
    job.fullTextStrategyId,
    freshness.dirtyToken,
    freshness.lastCompletedDirtyToken,
  )
  const cached = unassessedCountCache.get(cacheKey)
  const now = Date.now()
  if (freshness.isFresh && cached && cached.expiresAt > now) {
    return {
      count: cached.value,
      freshness: getProjectMartFreshnessPayload(freshness),
      freshnessStatus: freshness.status,
    }
  }

  const count = await getJudgmentJobUnassessedCountFromServing({
    projectId: job.projectId,
    projectDateFrom,
    projectDateTo,
    importRouteIds,
  })

  if (freshness.isFresh) {
    unassessedCountCache.set(cacheKey, {value: count, expiresAt: now + unassessedCountTTLms})
  }

  return {count, freshness: getProjectMartFreshnessPayload(freshness), freshnessStatus: freshness.status}
}
