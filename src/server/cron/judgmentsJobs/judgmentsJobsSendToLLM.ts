import {rateLimitedLogger} from '../../utils/rateLimitedLogger.ts'
import {ConnectionError} from './connectionHealth.ts'
import {getCodexMaxInflight} from './getCodexMaxInflight.ts'
import {getJudgmentsCapacity} from './getJudgmentsCapacity.ts'
import {getJudgmentJobSqliteService} from './judgmentJobSqliteService.ts'
import {filterRunningJobsByRuntimeMatch, type RunningJudgmentJob} from './judgmentsJobsGetRunningJobs.ts'
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

type Capacity = {maxInflight: number; maxBurst: number; workerCount: number}
type CapacityBucket<T> = {capacity: Capacity; jobs: T[]; label: string}
type JobRequestAllocation<T> = {job: T; limit: number}
type ProviderConnectionRequestAllocation<T> = {connectionId: string; jobs: JobRequestAllocation<T>[]; limit: number}

const getCapacityFromMaxInflight = (maxInflightRequests: number): Capacity => {
  const limit = Math.max(1, maxInflightRequests)

  return {maxBurst: limit, maxInflight: limit, workerCount: limit}
}

const getProviderFamilyDefaultMaxInflight = ({
  getCodexDefaultMaxInflight,
  getNonCodexCapacity,
  job,
}: {
  getCodexDefaultMaxInflight: () => number
  getNonCodexCapacity: (runningJobCount: number) => Capacity
  job: RunningJudgmentJob
}): number => {
  return isCodexJob(job) ? getCodexDefaultMaxInflight() : getNonCodexCapacity(1).maxInflight
}

export const getEffectiveProviderCap = ({
  getCodexDefaultMaxInflight = getCodexMaxInflight,
  getNonCodexCapacity = getJudgmentsCapacity,
  job,
}: {
  getCodexDefaultMaxInflight?: () => number
  getNonCodexCapacity?: (runningJobCount: number) => Capacity
  job: RunningJudgmentJob
}): {maxInflight: number; usesFamilyDefault: boolean} => {
  const savedMaxInflight = job.maxInflightRequests
  const providerFamilyDefaultMaxInflight = getProviderFamilyDefaultMaxInflight({
    getCodexDefaultMaxInflight,
    getNonCodexCapacity,
    job,
  })
  const maxInflight = Math.max(1, savedMaxInflight ?? providerFamilyDefaultMaxInflight)

  return {maxInflight, usesFamilyDefault: savedMaxInflight == null}
}

export const getCapacityBuckets = ({
  getCodexDefaultMaxInflight = getCodexMaxInflight,
  getNonCodexCapacity = getJudgmentsCapacity,
  jobs,
}: {
  getCodexDefaultMaxInflight?: () => number
  getNonCodexCapacity?: (runningJobCount: number) => Capacity
  jobs: RunningJudgmentJob[]
}): CapacityBucket<RunningJudgmentJob>[] => {
  const grouped = jobs.reduce(
    (state, job) => {
      const providerCap = getEffectiveProviderCap({getCodexDefaultMaxInflight, getNonCodexCapacity, job})
      const connectionKey = providerCap.usesFamilyDefault ? null : (job.providerConnectionId ?? job.id)

      return connectionKey
        ? {
            ...state,
            overriddenJobsByConnection: new Map(state.overriddenJobsByConnection).set(connectionKey, [
              ...(state.overriddenJobsByConnection.get(connectionKey) ?? []),
              job,
            ]),
          }
        : isCodexJob(job)
          ? {...state, defaultCodexJobs: [...state.defaultCodexJobs, job]}
          : {...state, defaultNonCodexJobs: [...state.defaultNonCodexJobs, job]}
    },
    {
      defaultCodexJobs: [] as RunningJudgmentJob[],
      defaultNonCodexJobs: [] as RunningJudgmentJob[],
      overriddenJobsByConnection: new Map<string, RunningJudgmentJob[]>(),
    },
  )
  const connectionBuckets = Array.from(grouped.overriddenJobsByConnection.entries())
    .map(([connectionId, connectionJobs]) => {
      const firstJob = connectionJobs[0]
      if (!firstJob) return null

      return {
        capacity: getCapacityFromMaxInflight(
          getEffectiveProviderCap({getCodexDefaultMaxInflight, getNonCodexCapacity, job: firstJob}).maxInflight,
        ),
        jobs: connectionJobs,
        label: `${isCodexJob(firstJob ?? {modelProvider: null}) ? 'codex' : 'provider'}:${connectionId}`,
      }
    })
    .filter((bucket): bucket is CapacityBucket<RunningJudgmentJob> => {
      return Boolean(bucket)
    })
  const defaultCodexMaxInflight = getCodexDefaultMaxInflight()
  const defaultBuckets = [
    grouped.defaultNonCodexJobs.length > 0
      ? {
          capacity: getNonCodexCapacity(grouped.defaultNonCodexJobs.length),
          jobs: grouped.defaultNonCodexJobs,
          label: 'non-codex',
        }
      : null,
    grouped.defaultCodexJobs.length > 0
      ? {capacity: getCapacityFromMaxInflight(defaultCodexMaxInflight), jobs: grouped.defaultCodexJobs, label: 'codex'}
      : null,
  ].filter((bucket): bucket is CapacityBucket<RunningJudgmentJob> => {
    return Boolean(bucket)
  })

  return [...connectionBuckets, ...defaultBuckets]
}

const getReadyCountsByJob = async (jobIds: string[]): Promise<Map<string, number>> => {
  const sqliteService = getJudgmentJobSqliteService()
  const pairs = await Promise.all(
    jobIds.map(async (jobId) => {
      return [jobId, await sqliteService.getReadyCount(jobId)] as const
    }),
  )

  return new Map(pairs)
}

const getInFlightCountsByJob = async (jobIds: string[]): Promise<Map<string, number>> => {
  const sqliteService = getJudgmentJobSqliteService()
  const pairs = await Promise.all(
    jobIds.map(async (jobId) => {
      return [jobId, await sqliteService.getInFlightCount(jobId)] as const
    }),
  )

  return new Map(pairs)
}

const requeueRejectedPrompts = async (prompts: PromptToProcess[]) => {
  const sqliteService = getJudgmentJobSqliteService()

  await Promise.all(
    prompts.map((prompt) => {
      return sqliteService.markPromptAsRetry(prompt.jobId, prompt.recordId)
    }),
  )
}

export const getRequestsToSendByJob = <T extends {id: string}>(
  jobs: T[],
  requestsToSend: number,
  readyCounts: Map<string, number>,
): JobRequestAllocation<T>[] => {
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

export const getRequestsToSendByProviderConnection = <T extends RunningJudgmentJob>({
  getCodexDefaultMaxInflight = getCodexMaxInflight,
  getNonCodexCapacity = getJudgmentsCapacity,
  jobs,
  maxRequestsToSend,
  inFlightCounts,
  readyCounts,
}: {
  getCodexDefaultMaxInflight?: () => number
  getNonCodexCapacity?: (runningJobCount: number) => Capacity
  jobs: T[]
  maxRequestsToSend: number
  inFlightCounts: Map<string, number>
  readyCounts: Map<string, number>
}): ProviderConnectionRequestAllocation<T>[] => {
  const connectionGroups = Array.from(
    jobs.reduce((state, job) => {
      const connectionId = job.providerConnectionId ?? job.id
      return new Map(state).set(connectionId, [...(state.get(connectionId) ?? []), job])
    }, new Map<string, T[]>()),
  ).map(([connectionId, connectionJobs]) => {
    const firstJob = connectionJobs[0]
    if (!firstJob) return null

    const providerCap = getEffectiveProviderCap({
      getCodexDefaultMaxInflight,
      getNonCodexCapacity,
      job: firstJob,
    }).maxInflight
    const ready = connectionJobs.reduce((sum, job) => {
      return sum + (readyCounts.get(job.id) ?? 0)
    }, 0)
    const promptsInFlight = connectionJobs.reduce((sum, job) => {
      return sum + (inFlightCounts.get(job.id) ?? 0)
    }, 0)

    return {connectionId, jobs: connectionJobs, limit: Math.max(0, Math.min(ready, providerCap - promptsInFlight))}
  })
  const sendableConnectionGroups = connectionGroups.filter(
    (group): group is {connectionId: string; jobs: T[]; limit: number} => {
      return group !== null && group.limit > 0
    },
  )

  if (sendableConnectionGroups.length === 0 || maxRequestsToSend <= 0) return []

  const connectionLimits = getRequestsToSendByJob(
    sendableConnectionGroups.map((group) => {
      return {id: group.connectionId}
    }),
    maxRequestsToSend,
    new Map(
      sendableConnectionGroups.map((group) => {
        return [group.connectionId, group.limit] as const
      }),
    ),
  )

  return connectionLimits.flatMap(({job: connection, limit}) => {
    const connectionGroup = sendableConnectionGroups.find((group) => {
      return group.connectionId === connection.id
    })
    if (!connectionGroup) return []

    const jobLimits = getRequestsToSendByJob(connectionGroup.jobs, limit, readyCounts)
    return jobLimits.length > 0 ? [{connectionId: connectionGroup.connectionId, jobs: jobLimits, limit}] : []
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

let isRunningJudgmentsJobsSendToLLM = false

export const requeueAndFilterRunningJobs = async ({
  allJobs,
  filterJobs = filterRunningJobsByRuntimeMatch,
  requeueSentPrompts = requeueAbandonedSentPrompts,
  serverJobId,
}: {
  allJobs: RunningJudgmentJob[]
  filterJobs?: (jobs: RunningJudgmentJob[]) => Promise<RunningJudgmentJob[]>
  requeueSentPrompts?: (params: {jobIds: string[]; serverJobId: string}) => Promise<number>
  serverJobId: string
}): Promise<RunningJudgmentJob[]> => {
  await requeueSentPrompts({
    jobIds: allJobs.map((job) => {
      return job.id
    }),
    serverJobId,
  })

  return filterJobs(allJobs)
}

const sendToLLMForJobs = async (
  jobs: RunningJudgmentJob[],
  serverJobId: string,
  capacity: Capacity,
  label: string,
): Promise<void> => {
  if (jobs.length === 0) return

  const jobIds = jobs.map((job) => {
    return job.id
  })
  const inFlightCounts = await getInFlightCountsByJob(jobIds)
  const promptsInFlight = Array.from(inFlightCounts.values()).reduce((sum, count) => {
    return sum + count
  }, 0)
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

  const requestsToSendByJob = getRequestsToSendByProviderConnection({
    jobs,
    maxRequestsToSend: requestsToSend,
    inFlightCounts,
    readyCounts,
  }).flatMap(({jobs: connectionJobs}) => {
    return connectionJobs
  })
  console.log(
    `[capacity:${label}] requestsToSendByJob:`,
    requestsToSendByJob.map(({job, limit}) => {
      return {jobId: job.id.slice(0, 8), limit}
    }),
  )

  const promptClaimResults = await Promise.allSettled(
    requestsToSendByJob.map(({job, limit}) => {
      const providerCap = getEffectiveProviderCap({job})

      return getAndUpdateReadyPrompts(serverJobId, job.id, limit, {
        providerConnectionId: job.providerConnectionId,
        providerMaxInflightRequests: providerCap.maxInflight,
        providerUsesFamilyDefault: providerCap.usesFamilyDefault,
      })
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

export const judgmentsJobsSendToLLM = async (allJobs: RunningJudgmentJob[], serverJobId: string): Promise<void> => {
  if (isRunningJudgmentsJobsSendToLLM) return
  isRunningJudgmentsJobsSendToLLM = true

  try {
    const sendableJobs = await requeueAndFilterRunningJobs({allJobs, serverJobId})
    const capacityBuckets = getCapacityBuckets({jobs: sendableJobs})

    await Promise.all(
      capacityBuckets.map(({capacity, jobs, label}) => {
        return sendToLLMForJobs(jobs, serverJobId, capacity, label)
      }),
    )
  } finally {
    isRunningJudgmentsJobsSendToLLM = false
  }
}
