import {judgmentsJobsCronGetArticles} from './judgmentsJobsCronGetArticles.ts'
import type {ArticleProcessingData, JobData} from './judgmentsJobsTypes.ts'

const ARTICLES_BATCH_SIZE = 1

const getExistingArticleIds = (existingData: ArticleProcessingData[]): string[] =>
  existingData.reduce<string[]>((acc, {articlesToJudgeIds}) => [...acc, ...articlesToJudgeIds], [])

const fetchArticlesForJob = async (
  job: JobData,
  existingArticleIds: string[],
): Promise<ArticleProcessingData> => {
  const {articlesToJudgeIds, articlesToJudge, projectPrompts} = await judgmentsJobsCronGetArticles(
    job.projectId,
    ARTICLES_BATCH_SIZE,
    existingArticleIds,
  )
  
  return {articlesToJudgeIds, articlesToJudge, projectPrompts}
}

export const fetchNewArticlesForAllJobs = async (
  allJobs: JobData[],
  articlesAlreadyProcessing: Map<string, ArticleProcessingData[]>,
): Promise<[string, ArticleProcessingData][]> => {
  return await Promise.all(
    allJobs.map(async (job) => {
      const existingData = articlesAlreadyProcessing.get(job.jobId) || []
      const existingArticleIds = getExistingArticleIds(existingData)
      const newArticleData = await fetchArticlesForJob(job, existingArticleIds)
      
      return [job.jobId, newArticleData]
    }),
  )
}

export const updateProcessingMap = (
  articlesAlreadyProcessing: Map<string, ArticleProcessingData[]>,
  newArticlesInProcess: [string, ArticleProcessingData][],
): void => {
  newArticlesInProcess.forEach(([jobId, data]) => {
    if (jobId && typeof jobId === 'string') {
      const previousArticles = articlesAlreadyProcessing.get(jobId) || []
      articlesAlreadyProcessing.set(jobId, [...previousArticles, data])
    }
  })
}