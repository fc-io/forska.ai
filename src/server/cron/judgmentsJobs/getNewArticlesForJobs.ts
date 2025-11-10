import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../db/schema.ts'
import {getNumberOfArticlesInReadyQueue} from './getNumberOfArticlesInReadyQueue.ts'
import {isReadyToGetMoreArticles} from './isReadyToGetMoreArticles.ts'
import {judgmentsJobsAddToJobsQueue} from './judgmentsJobsAddToJobsQueue.ts'
import {judgmentsJobsGetJobs} from './judgmentsJobsGetJobs.ts'
import {judgmentsJobsGetNewArticles} from './judgmentsJobsGetNewArticles.ts'

export const getNewArticlesForJobs = async (db: PostgresJsDatabase<typeof schema>, serverJobId: string) => {
  const numberOfArticlesInReadyQueue = await getNumberOfArticlesInReadyQueue(db, serverJobId)
  const allJobs = await judgmentsJobsGetJobs(db)

  if (isReadyToGetMoreArticles(numberOfArticlesInReadyQueue)) {
    const newArticlesToProcess = await judgmentsJobsGetNewArticles(db, allJobs)
    const totalArticles = newArticlesToProcess.reduce((sum, job) => {
      return sum + job.articlesToJudgeIds.length
    }, 0)
    // console.log(`newArticlesToProcess | jobs: ${newArticlesToProcess.length}, totalArticles: ${totalArticles}`)
    if (totalArticles > 0) {
      await judgmentsJobsAddToJobsQueue(db, newArticlesToProcess, serverJobId)
    }
  }
}
