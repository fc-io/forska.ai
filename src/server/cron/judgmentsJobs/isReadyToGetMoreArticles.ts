import {MAX_ARTICLES_BATCH_SIZE} from '../judgmentsJobs.ts'
import type {judgmentsJobsGetJobs} from './judgmentsJobsGetJobs.ts'

const getTotalNumberOfArticlesToProcessInEachBatch = (
  allJobs: Awaited<ReturnType<typeof judgmentsJobsGetJobs>>,
): number => {
  return allJobs.reduce((acc, job) => {
    return acc + (job.sendToLLMBatchSize ?? MAX_ARTICLES_BATCH_SIZE)
  }, 0)
}

export const isReadyToGetMoreArticles = (
  numberOfArticlesInReadyQueue: number,
  allJobs: Awaited<ReturnType<typeof judgmentsJobsGetJobs>>,
): boolean => {
  return (
    // the 3*2 is to have a few more articles in queue if the llm bursts through the queue faster than predicted
    numberOfArticlesInReadyQueue * 3 * 2 > getTotalNumberOfArticlesToProcessInEachBatch(allJobs)
  )
}
