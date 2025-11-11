import {and, count, eq} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../db/schema.ts'
import {env} from '../../utils/env.ts'
import {getMaxNumberOfInflightRequests} from './getMaxNumberOfInflightRequests.ts'
import type {judgmentsJobsGetJobs} from './judgmentsJobsGetJobs.ts'
import {type ArticleToProcess, getAndUpdateReadyArticles} from './judgmentsJobsSendToLLM/getAndUpdateReadyArticles.ts'
import {processArticleWithLLM} from './judgmentsJobsSendToLLM/processArticleWithLLM.ts'

const processArticles = async (db: PostgresJsDatabase<typeof schema>, articles: ArticleToProcess[]): Promise<void> => {
  const results = await Promise.allSettled(
    articles.map((article) => {
      return processArticleWithLLM(db, article)
    }),
  )

  const rejected = results.filter((r) => {
    return r.status === 'rejected'
  }).length

  if (rejected > 0) {
    console.error('send to LLM: processing errors', JSON.stringify({rejected, total: results.length}))
  }
}

const getNumberOfArticlesInFlight = async (
  db: PostgresJsDatabase<typeof schema>,
  serverJobId: string,
): Promise<number> => {
  const result = await db
    .select({count: count()})
    .from(schema.judgmentsJobsArticles)
    .where(and(eq(schema.judgmentsJobsArticles.status, 'sent'), eq(schema.judgmentsJobsArticles.serverId, serverJobId)))

  return result[0]?.count || 0
}

let hasLogged = false
let isRunningJudgmentsJobsSendToLLM = false

export const judgmentsJobsSendToLLM = async (
  db: PostgresJsDatabase<typeof schema>,
  allJobs: Awaited<ReturnType<typeof judgmentsJobsGetJobs>>,
  serverJobId: string,
): Promise<void> => {
  if (isRunningJudgmentsJobsSendToLLM) return
  if (!hasLogged) {
    console.log(`1. send ${allJobs.length} jobs to LLM`)
    hasLogged = true
  }
  isRunningJudgmentsJobsSendToLLM = true
  const maxNumberOfInflightRequests = getMaxNumberOfInflightRequests()
  const articlesInFlight = await getNumberOfArticlesInFlight(db, serverJobId)
  const maxNumberOfRequestsToSendAtOnce = Math.ceil(env.SGLANG_MAX_RUNNING_REQUESTS / 15)
  const requestsToSend = Math.min(maxNumberOfRequestsToSendAtOnce, maxNumberOfInflightRequests - articlesInFlight)
  console.log('requestsToSend', requestsToSend)
  if (requestsToSend > 0 && allJobs.length > 0) {
    const requestsToSendPerJob = Math.max(1, Math.floor(requestsToSend / allJobs.length))

    const articlesToProcess = await Promise.allSettled(
      allJobs.map((job) => {
        return getAndUpdateReadyArticles(db, serverJobId, job.id, requestsToSendPerJob)
      }),
    ).then((results) => {
      return results
        .filter((result) => {
          return result.status === 'fulfilled'
        })
        .map((result) => {
          return result.value
        })
    })

    articlesToProcess.forEach((articles) => {
      void (async () => {
        // TODO: fix the bug with not enough articles sent when when too few articles in project
        if (articles.length > 0) {
          await processArticles(db, articles)
        } else {
          console.log('No articles to process – this should not happen, prob bug if it does')
        }
      })().catch((error) => {
        const safeError =
          error instanceof Error
            ? {name: error.name, message: error.message, stack: error.stack}
            : {message: String(error)}
        console.error('judgmentsJobsSendToLLM job failed', {error: safeError})
      })
    })
  }
  isRunningJudgmentsJobsSendToLLM = false
}
