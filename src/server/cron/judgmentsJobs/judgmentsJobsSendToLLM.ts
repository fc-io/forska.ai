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

const getReadyCountsByJob = async (
  db: PostgresJsDatabase<typeof schema>,
  jobIds: string[],
): Promise<Map<string, number>> => {
  const hasJobs = jobIds.length > 0
  if (!hasJobs) return new Map()

  const readyCounts = await db
    .select({jobId: schema.judgmentsJobsPrompts.jobId, ready: count()})
    .from(schema.judgmentsJobsPrompts)
    .where(and(eq(schema.judgmentsJobsPrompts.status, 'ready'), inArray(schema.judgmentsJobsPrompts.jobId, jobIds)))
    .groupBy(schema.judgmentsJobsPrompts.jobId)

  const pairs = readyCounts.map((row) => {
    return [row.jobId, Number(row.ready)] as const
  })
  return new Map(pairs)
}

const getRequestsToSendByJob = <T extends {id: string}>(
  jobs: T[],
  requestsToSend: number,
  readyCounts: Map<string, number>,
): {job: T; limit: number}[] => {
  const shuffled = shuffle(jobs)
  const withReady = shuffled
    .map((job) => {
      const ready = readyCounts.get(job.id) ?? 0
      return {job, ready}
    })
    .filter(({ready}) => {
      return ready > 0
    })

  const hasBudget = withReady.length > 0 && requestsToSend > 0
  if (!hasBudget) return []

  const base = Math.floor(requestsToSend / withReady.length)
  const remainder = requestsToSend % withReady.length

  const initialAllocations = withReady.map((entry, idx) => {
    const desired = base + (idx < remainder ? 1 : 0)
    const limit = Math.min(entry.ready, desired)
    const remainingReady = Math.max(0, entry.ready - limit)
    return {...entry, limit, remainingReady}
  })

  const used = initialAllocations.reduce((sum, entry) => {
    return sum + entry.limit
  }, 0)
  const leftover = Math.max(0, requestsToSend - used)
  const hasLeftover = leftover > 0
  const withRemaining = initialAllocations.filter((entry) => {
    return entry.remainingReady > 0
  })

  const redistributed =
    hasLeftover && withRemaining.length > 0
      ? getRequestsToSendByJob(
          withRemaining.map((entry) => {
            return entry.job
          }),
          leftover,
          new Map(
            withRemaining.map((entry) => {
              return [entry.job.id, entry.remainingReady] as const
            }),
          ),
        )
      : []

  const merged = initialAllocations.map((entry) => {
    const extra = redistributed.find((r) => {
      return r.job.id === entry.job.id
    })
    const totalLimit = entry.limit + (extra?.limit ?? 0)
    return {job: entry.job, limit: totalLimit}
  })

  return merged.filter(({limit}) => {
    return limit > 0
  })
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

  const fulfilled = results.filter((r) => {
    return r.status === 'fulfilled'
  })
  const rejected = results.filter((r) => {
    return r.status === 'rejected'
  })

  // Count connection errors specifically
  const connectionErrors = rejected.filter((r) => {
    return r.reason instanceof ConnectionError
  }).length

  // Always log batch completion stats
  console.log('[llm] Batch complete:', {
    sent: prompts.length,
    fulfilled: fulfilled.length,
    rejected: rejected.length,
    connectionErrors,
  })

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
  _serverJobId: string, // Kept for API compat but not used - we count ALL sent prompts
): Promise<number> => {
  // IMPORTANT: Count ALL 'sent' prompts, not just this server's.
  // This prevents queue overflow when the server restarts:
  // - Old prompts with old serverJobId are still in DB with status='sent'
  // - Old prompts are still in SGLang's queue
  // - If we only counted our own serverJobId, we'd send 2000 more requests
  const result = await db
    .select({count: count()})
    .from(schema.judgmentsJobsPrompts)
    .where(eq(schema.judgmentsJobsPrompts.status, 'sent'))

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
    const jobIds = allJobs.map((job) => {
      return job.id
    })
    const readyCounts = await getReadyCountsByJob(db, jobIds)

    // Debug logging for capacity issues
    if (requestsToSend > 0 || promptsInFlight > capacity.maxInflight * 0.9) {
      const readyCountsObj = Object.fromEntries(readyCounts)
      console.log('[capacity]', {
        requestsToSend,
        promptsInFlight,
        maxInflight: capacity.maxInflight,
        maxBurst: capacity.maxBurst,
        workerCount: capacity.workerCount,
        deficit,
        jobCount: allJobs.length,
        readyCounts: readyCountsObj,
      })
    }

    if (requestsToSend > 0 && allJobs.length > 0) {
      const requestsToSendByJob = getRequestsToSendByJob(allJobs, requestsToSend, readyCounts)
      console.log(
        '[capacity] requestsToSendByJob:',
        requestsToSendByJob.map(({job, limit}) => {
          return {jobId: job.id.slice(0, 8), limit}
        }),
      )

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

      // Log actual prompts fetched vs requested - detect if more are being sent than allowed
      const totalPromptsFetched = promptsToProcess.reduce((sum, arr) => {
        return sum + arr.length
      }, 0)
      if (totalPromptsFetched !== requestsToSend) {
        console.warn('[capacity] MISMATCH: fetched', totalPromptsFetched, 'but requested', requestsToSend)
      }

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
