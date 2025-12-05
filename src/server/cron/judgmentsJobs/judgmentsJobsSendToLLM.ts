import {and, count, eq} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../db/schema.ts'
import {env} from '../../utils/env.ts'
import {getMaxNumberOfInflightRequests} from './getMaxNumberOfInflightRequests.ts'
import type {judgmentsJobsGetRunningJobs} from './judgmentsJobsGetRunningJobs.ts'
import {getAndUpdateReadyPrompts, type PromptToProcess} from './judgmentsJobsSendToLLM/getAndUpdateReadyPrompts.ts'
import {processPromptWithLLM} from './judgmentsJobsSendToLLM/processPromptWithLLM.ts'

const processPrompts = async (db: PostgresJsDatabase<typeof schema>, prompts: PromptToProcess[]): Promise<void> => {
  const results = await Promise.allSettled(
    prompts.map((prompt) => {
      return processPromptWithLLM(db, prompt)
    }),
  )

  const rejected = results.filter((r) => {
    return r.status === 'rejected'
  }).length

  if (rejected > 0) {
    console.error('send to LLM: processing errors', JSON.stringify({rejected, total: results.length}))
  }
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
  const maxNumberOfInflightRequests = getMaxNumberOfInflightRequests()
  const promptsInFlight = await getNumberOfPromptsInFlight(db, serverJobId)
  const deficit = Math.max(0, maxNumberOfInflightRequests - promptsInFlight)
  const maxBurst = Math.max(1, Number(env.SGLANG_MAX_RUNNING_REQUESTS || 0))
  const requestsToSend = Math.min(deficit, maxBurst)
  console.log('requestsToSend', requestsToSend)
  if (requestsToSend > 0 && allJobs.length > 0) {
    const requestsToSendPerJob = Math.max(1, Math.floor(requestsToSend / allJobs.length))

    const promptsToProcess = await Promise.allSettled(
      allJobs.map((job) => {
        return getAndUpdateReadyPrompts(db, serverJobId, job.id, requestsToSendPerJob)
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
          await processPrompts(db, prompts)
        } else {
          console.log('No prompts to process – this should not happen, prob bug if it does')
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
