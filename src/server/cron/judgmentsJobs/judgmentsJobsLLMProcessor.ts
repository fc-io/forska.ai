import {judge} from '../../../agent/judge.ts'
import type {ArticleProcessingData} from './judgmentsJobsTypes.ts'

type ArticleDataWithJobId = ArticleProcessingData & {jobId: string}

const extractUnsentArticles = (
  jobIds: string[],
  articlesAlreadyProcessing: Map<string, ArticleProcessingData[]>,
): ArticleDataWithJobId[] => {
  return jobIds.reduce<ArticleDataWithJobId[]>((acc, jobId) => {
    const jobData = articlesAlreadyProcessing.get(jobId) || []
    const unsentData = jobData
      .filter(({isSentToLLM}) => isSentToLLM === undefined)
      .map((d) => ({...d, jobId}))
    return [...acc, ...unsentData]
  }, [])
}

const markArticlesAsSent = (
  jobIds: string[],
  articlesAlreadyProcessing: Map<string, ArticleProcessingData[]>,
): void => {
  jobIds.forEach((jobId) => {
    const data = articlesAlreadyProcessing.get(jobId) || []
    articlesAlreadyProcessing.set(
      jobId,
      data.map((d) => ({...d, isSentToLLM: true})),
    )
  })
}

const processArticleWithLLM = async (data: ArticleDataWithJobId): Promise<void> => {
  const {articlesToJudge, projectPrompts} = data
  const sessionId = null
  
  try {
    await judge({articles: articlesToJudge, prompts: projectPrompts, sessionId})
  } catch (error) {
    console.error('Error sending to LLM:', error)
  }
}

const removeProcessedArticles = (
  articlesAlreadyProcessing: Map<string, ArticleProcessingData[]>,
  processedData: ArticleDataWithJobId,
): void => {
  const {jobId, articlesToJudgeIds} = processedData
  const currentProcessingList = articlesAlreadyProcessing.get(jobId) || []
  
  articlesAlreadyProcessing.set(
    jobId,
    currentProcessingList.filter(
      (item) => !item.articlesToJudgeIds.some((id) => articlesToJudgeIds.includes(id)),
    ),
  )
}

export const sendArticlesToLLM = async (
  jobIds: string[],
  articlesAlreadyProcessing: Map<string, ArticleProcessingData[]>,
): Promise<void> => {
  console.log('send to LLM')
  
  const unsentArticles = extractUnsentArticles(jobIds, articlesAlreadyProcessing)
  console.log('filteredToJudgeData length:', unsentArticles.length)
  
  markArticlesAsSent(jobIds, articlesAlreadyProcessing)
  
  await Promise.all(
    unsentArticles.map(async (data) => {
      await processArticleWithLLM(data)
      removeProcessedArticles(articlesAlreadyProcessing, data)
    }),
  )
  
  console.log('end send to LLM')
}