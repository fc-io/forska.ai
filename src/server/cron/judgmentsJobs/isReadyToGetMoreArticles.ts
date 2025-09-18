import {MAX_ARTICLES_BATCH_SIZE} from '../judgmentsJobs.ts'
import type {judgmentsJobsGetJobs} from './judgmentsJobsGetJobs.ts'

export const isReadyToGetMoreArticles = (
  numberOfArticlesInReadyQueue: number,
  allJobs: Awaited<ReturnType<typeof judgmentsJobsGetJobs>>,
): boolean => {
  return (
    numberOfArticlesInReadyQueue
    > allJobs.reduce((acc, job) => {
      return acc + (job.sendToLLMBatchSize ?? MAX_ARTICLES_BATCH_SIZE)
    }, 0)
  )
}
