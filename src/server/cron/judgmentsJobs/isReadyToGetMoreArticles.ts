import type {judgmentsJobsGetJobs} from './judgmentsJobsGetJobs.ts'

const getTotalNumberOfArticlesToProcessInEachBatch = (
  allJobs: Awaited<ReturnType<typeof judgmentsJobsGetJobs>>,
): number => {
  return allJobs.reduce((acc, job) => {
    return acc + job.sendToLLMBatchSize
  }, 0)
}

export const isReadyToGetMoreArticles = (
  numberOfArticlesInReadyQueue: number,
  allJobs: Awaited<ReturnType<typeof judgmentsJobsGetJobs>>,
): boolean => {
  return (
    // The *3 is to have a few more articles in queue if the llm bursts through the queue faster than predicted.
    // The 3 is to fill up the queue with 3 times as much artilces as was used in the previous
    // sendToLLMCronJob call so that if we increase the amount of articles to send we will already
    // have enough articles in the ready queue.
    numberOfArticlesInReadyQueue < getTotalNumberOfArticlesToProcessInEachBatch(allJobs) * 3
  )
}
