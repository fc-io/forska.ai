import {and, count, eq, inArray} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../db/schema.ts'
import {rateLimitedLogger} from '../../utils/rateLimitedLogger.ts'
import {workerLoadBalancer} from '../../utils/workerLoadBalancer.ts'
import {ConnectionError, isCircuitOpen} from './connectionHealth.ts'
import {getJudgmentsCapacity} from './getJudgmentsCapacity.ts'
import type {judgmentsJobsGetRunningJobs} from './judgmentsJobsGetRunningJobs.ts'
import {getAndUpdateReadyPrompts, type PromptToProcess} from './judgmentsJobsSendToLLM/getAndUpdateReadyPrompts.ts'
import {processPromptWithLLM} from './judgmentsJobsSendToLLM/processPromptWithLLM.ts'

const shuffle = <T>(items: T[]): T[] => {
  return items
    .map((item) => {
      return {item, sort: Math.random()}
    })
    .sort((a, b) => {
      return a.sort - b.sort
    })
    .map((entry) => {
      return entry.item
    })
}

const getRequestsToSendByJob = <T>(jobs: T[], requestsToSend: number): {job: T; limit: number}[] => {
  const jobCount = jobs.length
  const hasBudget = jobCount > 0 && requestsToSend > 0
  const base = hasBudget ? Math.floor(requestsToSend / jobCount) : 0
  const remainder = hasBudget ? requestsToSend % jobCount : 0
  const shuffled = hasBudget ? shuffle(jobs) : []
  const allocations = shuffled
    .map((job, idx) => {
      const limit = base + (idx < remainder ? 1 : 0)
      return {job, limit}
    })
    .filter(({limit}) => {
      return limit > 0
    })

  return hasBudget ? allocations : []
}

const processPrompts = async (
  db: PostgresJsDatabase<typeof schema>,
  prompts: PromptToProcess[],
): Promise<{connectionErrors: number}> => {
  const results = await Promise.allSettled(
    prompts.map(async (prompt) => {
      // Add random jitter (0-1000ms) to desynchronize requests and effectively smooth out
      // the burst load on the SSH tunnel/firewall.
      const jitterMs = Math.floor(Math.random() * 1000)
      try {
        await new Promise((resolve) => {
          setTimeout(resolve, jitterMs)
        })
        return await processPromptWithLLM(db, prompt)
      } finally {
        workerLoadBalancer.releaseWorker(prompt.modelBaseUrl)
      }
    }),
  )

  const rejected = results.filter((r) => {
    return r.status === 'rejected'
  })

  // Count connection errors specifically
  const connectionErrors = rejected.filter((r) => {
    return r.reason instanceof ConnectionError
  }).length

  if (rejected.length > 0) {
    rateLimitedLogger.error(
      'llm:processing-errors',
      `send to LLM: processing errors ${JSON.stringify({rejected: rejected.length, connectionErrors, total: results.length})}`,
    )
  }

  return {connectionErrors}
}

const getNumberOfPromptsInFlight = async (
  db: PostgresJsDatabase<typeof schema>,
  serverJobId: string,
): Promise<number> => {
  const result = await db
    .select({count: count()})
    .from(schema.judgmentsJobsPrompts)
    .where(and(eq(schema.judgmentsJobsPrompts.status, 'sent'), eq(schema.judgmentsJobsPrompts.serverId, serverJobId)))

  return result[0]?.count || 0
}

let isRunningJudgmentsJobsSendToLLM = false

export const judgmentsJobsSendToLLM = async (
  db: PostgresJsDatabase<typeof schema>,
  allJobs: Awaited<ReturnType<typeof judgmentsJobsGetRunningJobs>>,
  serverJobId: string,
): Promise<void> => {
  if (isRunningJudgmentsJobsSendToLLM) return
  isRunningJudgmentsJobsSendToLLM = true

  try {
    // Note: Circuit breaker is checked per-prompt below, since prompts have modelBaseUrl
    // and we don't have a global SGLANG_BASE_URL in the env schema

    const capacity = getJudgmentsCapacity(allJobs.length)
    const promptsInFlight = await getNumberOfPromptsInFlight(db, serverJobId)
    const deficit = Math.max(0, capacity.maxInflight - promptsInFlight)
    const requestsToSend = Math.min(deficit, capacity.maxBurst)
    // console.log('requestsToSend', {
    //   requestsToSend,
    //   maxInflight: capacity.maxInflight,
    //   promptsInFlight,
    //   sglangBurst: capacity.maxBurst,
    //   topology: {totalGpus: env.GPU_TOTAL_GPUS, tp: env.TP_SIZE, pp: env.PP_SIZE},
    // })

    if (requestsToSend > 0 && allJobs.length > 0) {
      const requestsToSendByJob = getRequestsToSendByJob(allJobs, requestsToSend)

      const promptsToProcess = await Promise.allSettled(
        requestsToSendByJob.map(({job, limit}) => {
          return getAndUpdateReadyPrompts(db, serverJobId, job.id, limit)
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

      promptsToProcess.map((prompts) => {
        void (async () => {
          if (prompts.length > 0) {
            // Filter out prompts for servers with open circuit breakers
            const blockedByCircuitBreaker: PromptToProcess[] = []
            const promptsToSend = prompts.filter((prompt) => {
              if (isCircuitOpen(prompt.modelBaseUrl)) {
                blockedByCircuitBreaker.push(prompt)
                workerLoadBalancer.releaseWorker(prompt.modelBaseUrl)
                return false
              }
              return true
            })

            if (blockedByCircuitBreaker.length > 0) {
              // Rate-limited log to avoid spam when circuit breaker is blocking many prompts
              const uniqueUrls = [
                ...new Set(
                  blockedByCircuitBreaker.map((p) => {
                    return p.modelBaseUrl
                  }),
                ),
              ]
              const key = `circuit:blocked:${uniqueUrls.join(',')}`
              rateLimitedLogger.log(
                key,
                `Circuit breaker blocked ${blockedByCircuitBreaker.length} prompts for: ${uniqueUrls.join(', ')}`,
              )

              // Reset blocked prompts back to 'ready' so they can be retried
              // These were marked as 'sent' in getAndUpdateReadyPrompts but never actually dispatched
              const blockedIds = blockedByCircuitBreaker.map((p) => {
                return p.recordId
              })
              await db
                .update(schema.judgmentsJobsPrompts)
                .set({status: 'ready', updatedAt: new Date()})
                .where(inArray(schema.judgmentsJobsPrompts.id, blockedIds))
            }

            if (promptsToSend.length > 0) {
              await processPrompts(db, promptsToSend)
            }
            // Removed redundant "All prompts blocked" log - the above log already covers this
          } else {
            // console.log('No prompts to process – this should not happen, prob bug if it does')
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
  } finally {
    isRunningJudgmentsJobsSendToLLM = false
  }
}
