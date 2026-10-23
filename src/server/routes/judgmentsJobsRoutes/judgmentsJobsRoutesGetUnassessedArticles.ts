import {getJudgmentJobUnassessedArticlesFromServing} from '../../reviewServing/reviewServingJudgmentJobQueueService.ts'
import {getJobContext} from './getJobContext.ts'
import {getProjectMartFreshnessPayload, getProjectMartFreshnessState} from './projectMartFreshness.ts'

export const judgmentsJobsRoutesGetUnassessedArticles = async ({query}: {query: {jobId: string}}) => {
  const {projectDateFrom, projectDateTo, importRouteIds, job} = await getJobContext({jobId: query.jobId})
  const freshness = await getProjectMartFreshnessState(job.projectId)

  const {articles} = await getJudgmentJobUnassessedArticlesFromServing({
    projectId: job.projectId,
    projectDateFrom,
    projectDateTo,
    importRouteIds,
    limit: 100,
  })

  const unassessedArticles = articles.map((a) => {
    return {
      id: a.id,
      articleId: a.articleId,
      articleTitle: a.articleTitle,
      articleAuthors: null,
      articleCreatedAt: a.articleCreatedAt,
      articleUpdatedAt: a.articleUpdatedAt,
      arxivId: null,
      biorxivId: null,
      doi: null,
      medrxivId: null,
      pubmedId: null,
      sourceMetadata: null,
      url: null,
    }
  })

  return {
    data: unassessedArticles,
    error: null,
    freshness: getProjectMartFreshnessPayload(freshness),
    freshnessStatus: freshness.status,
  }
}
