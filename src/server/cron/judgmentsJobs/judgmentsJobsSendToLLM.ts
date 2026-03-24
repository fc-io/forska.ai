import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getQuotedStringList} from '../../services/appQueryHelpers.ts'
import {rateLimitedLogger} from '../../utils/rateLimitedLogger.ts'
import {ConnectionError} from './connectionHealth.ts'
import {getCodexMaxInflight} from './getCodexMaxInflight.ts'
import {getJudgmentsCapacity} from './getJudgmentsCapacity.ts'
import {getJudgmentJobSqliteService} from './judgmentJobSqliteService.ts'
import type {judgmentsJobsGetRunningJobs} from './judgmentsJobsGetRunningJobs.ts'
import {getAndUpdateReadyPrompts, type PromptToProcess} from './judgmentsJobsSendToLLM/getAndUpdateReadyPrompts.ts'
import {processPromptWithLLM} from './judgmentsJobsSendToLLM/processPromptWithLLM.ts'
import {requeueAbandonedSentPrompts} from './requeueAbandonedSentPrompts.ts'

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

const normalizeProvider = (value: string | null | undefined): string => {
  const v = String(value ?? '')
    .trim()
    .toLowerCase()
  return v.length > 0 ? v : 'unknown'
}

const isCodexJob = (job: {modelProvider: string | null}): boolean => {
  return normalizeProvider(job.modelProvider) === 'codex'
}

const getReadyCountsByJob = async (jobIds: string[]): Promise<Map<string, number>> => {
  const hasJobs = jobIds.length > 0
  if (!hasJobs) return new Map()

  const sqliteService = getJudgmentJobSqliteService()
  const sqliteJobIds = jobIds.filter((jobId) => {
    return sqliteService.hasJob(jobId)
  })
  const duckdbJobIds = jobIds.filter((jobId) => {
    return !sqliteService.hasJob(jobId)
  })

  const sqlitePairs = await Promise.all(
    sqliteJobIds.map(async (jobId) => {
      return [jobId, await sqliteService.getReadyCount(jobId)] as const
    }),
  )

  const readyCounts =
    duckdbJobIds.length === 0
      ? []
      : await getAppDatabaseService().queryJson<{jobId: string; ready: number}>(`
          SELECT job_id AS jobId, COUNT(*) AS ready
          FROM app.judgment_job_prompt
          WHERE status = 'ready'
            AND job_id IN (${getQuotedStringList(duckdbJobIds).join(', ')})
          GROUP BY job_id
        `)

  const pairs = readyCounts.map((row) => {
    return [row.jobId, Number(row.ready)] as const
  })
  return new Map([...pairs, ...sqlitePairs])
}

const requeueRejectedPrompts = async (prompts: PromptToProcess[]) => {
  const sqliteService = getJudgmentJobSqliteService()
  const sqlitePrompts = prompts.filter((prompt) => {
    return sqliteService.hasJob(prompt.jobId)
  })
  const duckdbPrompts = prompts.filter((prompt) => {
    return !sqliteService.hasJob(prompt.jobId)
  })

  await Promise.all(
    sqlitePrompts.map((prompt) => {
      return sqliteService.markPromptAsRetry(prompt.jobId, prompt.recordId)
    }),
  )

  const rejectedRecordIds = duckdbPrompts.map((prompt) => {
    return prompt.recordId
  })

  if (rejectedRecordIds.length === 0) {
    return
  }

  await getAppDatabaseService().run(`
    UPDATE app.judgment_job_prompt
    SET status = 'ready',
        sent_at = NULL,
        updated_at = current_timestamp
    WHERE id IN (${getQuotedStringList(rejectedRecordIds).join(', ')})
  `)
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

const processPrompts = async (prompts: PromptToProcess[]): Promise<{connectionErrors: number}> => {
  const results = await Promise.allSettled(
    prompts.map(async (prompt) => {
      // Add random jitter (0-1000ms) to desynchronize requests and effectively smooth out
      // the burst load on the SSH tunnel/firewall.
      const jitterMs = Math.floor(Math.random() * 1000)
      await new Promise((resolve) => {
        setTimeout(resolve, jitterMs)
      })
      return processPromptWithLLM(prompt)
    }),
  )

  const fulfilled = results.filter((r) => {
    return r.status === 'fulfilled'
  })
  const rejected = results.filter((r) => {
    return r.status === 'rejected'
  })
  const rejectedPrompts = results.flatMap((result, index) => {
    return result.status === 'rejected'
      ? [prompts[index]].filter((prompt): prompt is PromptToProcess => {
          return Boolean(prompt)
        })
      : []
  })

  const connectionErrors = rejected.filter((r) => {
    return r.reason instanceof ConnectionError
  }).length
  const rejectedErrorSamples = rejected.slice(0, 3).map((result) => {
    const reason: unknown = result.reason
    return reason instanceof Error ? reason.message : String(reason)
  })

  console.log('[llm] Batch complete:', {
    claimedPrompts: prompts.length,
    fulfilled: fulfilled.length,
    rejected: rejected.length,
    connectionErrors,
  })

  if (rejected.length > 0) {
    rateLimitedLogger.error(
      'llm:processing-errors',
      `send to LLM: processing errors ${JSON.stringify({rejected: rejected.length, connectionErrors, total: results.length, rejectedErrorSamples})}`,
    )

    const rejectedRecordIds = rejectedPrompts.map((prompt) => {
      return prompt.recordId
    })

    if (rejectedRecordIds.length > 0) {
      await requeueRejectedPrompts(rejectedPrompts).catch((error: unknown) => {
        const safeError =
          error instanceof Error
            ? {name: error.name, message: error.message, stack: error.stack}
            : {message: String(error)}

        console.error('[llm] Failed to requeue rejected prompts', {
          error: safeError,
          rejectedRecordCount: rejectedRecordIds.length,
        })
      })
    }
  }

  return {connectionErrors}
}

const getNumberOfPromptsInFlight = async (jobIds: string[]): Promise<number> => {
  if (jobIds.length === 0) return 0

  const sqliteService = getJudgmentJobSqliteService()
  const sqliteJobIds = jobIds.filter((jobId) => {
    return sqliteService.hasJob(jobId)
  })
  const duckdbJobIds = jobIds.filter((jobId) => {
    return !sqliteService.hasJob(jobId)
  })
  const sqliteCounts = await Promise.all(
    sqliteJobIds.map((jobId) => {
      return sqliteService.getInFlightCount(jobId)
    }),
  )
  const sqliteCount = sqliteCounts.reduce((sum, count) => {
    return sum + count
  }, 0)
  const duckdbCount =
    duckdbJobIds.length === 0
      ? 0
      : Number(
          (
            await getAppDatabaseService().queryJson<{count: number}>(`
              SELECT COUNT(*) AS count
              FROM app.judgment_job_prompt
              WHERE status = 'sent'
                AND job_id IN (${getQuotedStringList(duckdbJobIds).join(', ')})
            `)
          )[0]?.count || 0,
        )

  return sqliteCount + duckdbCount
}

let isRunningJudgmentsJobsSendToLLM = false

const sendToLLMForJobs = async (
  jobs: Awaited<ReturnType<typeof judgmentsJobsGetRunningJobs>>,
  serverJobId: string,
  capacity: {maxInflight: number; maxBurst: number; workerCount: number},
  label: 'codex' | 'non-codex',
): Promise<void> => {
  if (jobs.length === 0) return

  const jobIds = jobs.map((job) => {
    return job.id
  })
  const promptsInFlight = await getNumberOfPromptsInFlight(jobIds)
  const deficit = Math.max(0, capacity.maxInflight - promptsInFlight)
  const requestsToSend = Math.min(deficit, capacity.maxBurst)
  const readyCounts = await getReadyCountsByJob(jobIds)

  if (requestsToSend > 0 || promptsInFlight > capacity.maxInflight * 0.9) {
    const readyCountsObj = Object.fromEntries(readyCounts)
    console.log(`[capacity:${label}]`, {
      requestsToSend,
      promptsInFlight,
      maxInflight: capacity.maxInflight,
      maxBurst: capacity.maxBurst,
      workerCount: capacity.workerCount,
      deficit,
      jobCount: jobs.length,
      readyCounts: readyCountsObj,
    })
  }

  if (requestsToSend <= 0) return

  const requestsToSendByJob = getRequestsToSendByJob(jobs, requestsToSend, readyCounts)
  console.log(
    `[capacity:${label}] requestsToSendByJob:`,
    requestsToSendByJob.map(({job, limit}) => {
      return {jobId: job.id.slice(0, 8), limit}
    }),
  )

  const promptClaimResults = await Promise.allSettled(
    requestsToSendByJob.map(({job, limit}) => {
      return getAndUpdateReadyPrompts(serverJobId, job.id, limit)
    }),
  )

  promptClaimResults.forEach((result, index) => {
    if (result.status === 'rejected') {
      const request = requestsToSendByJob[index]
      const reason: unknown = result.reason
      const safeError =
        reason instanceof Error
          ? {name: reason.name, message: reason.message, stack: reason.stack}
          : {message: String(reason)}

      console.error(`[capacity:${label}] failed to claim prompts`, {
        error: safeError,
        jobId: request?.job.id,
        requested: request?.limit,
      })
    }
  })

  const promptsToProcess = promptClaimResults
    .filter((result) => {
      return result.status === 'fulfilled'
    })
    .map((result) => {
      return result.value
    })

  const totalPromptsFetched = promptsToProcess.reduce((sum, arr) => {
    return sum + arr.length
  }, 0)
  if (totalPromptsFetched !== requestsToSend) {
    console.warn(`[capacity:${label}] mismatch: fetched`, totalPromptsFetched, 'but requested', requestsToSend)
  }

  promptsToProcess.map((prompts) => {
    void (async () => {
      if (prompts.length > 0) {
        await processPrompts(prompts)
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

export const judgmentsJobsSendToLLM = async (
  allJobs: Awaited<ReturnType<typeof judgmentsJobsGetRunningJobs>>,
  serverJobId: string,
): Promise<void> => {
  if (isRunningJudgmentsJobsSendToLLM) return
  isRunningJudgmentsJobsSendToLLM = true

  try {
    await requeueAbandonedSentPrompts({
      jobIds: allJobs.map((job) => {
        return job.id
      }),
      serverJobId,
    })

    const codexJobs = allJobs.filter(isCodexJob)
    const nonCodexJobs = allJobs.filter((job) => {
      return !isCodexJob(job)
    })

    const nonCodexCapacity = getJudgmentsCapacity(nonCodexJobs.length)
    const codexMaxInflight = getCodexMaxInflight()
    const codexCapacity = {maxInflight: codexMaxInflight, maxBurst: codexMaxInflight, workerCount: codexMaxInflight}

    await sendToLLMForJobs(nonCodexJobs, serverJobId, nonCodexCapacity, 'non-codex')
    await sendToLLMForJobs(codexJobs, serverJobId, codexCapacity, 'codex')
  } finally {
    isRunningJudgmentsJobsSendToLLM = false
  }
}
