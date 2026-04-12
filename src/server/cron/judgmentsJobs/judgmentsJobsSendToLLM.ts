import {rateLimitedLogger} from '../../utils/rateLimitedLogger.ts'
import {ConnectionError} from './connectionHealth.ts'
import {getCodexMaxInflight} from './getCodexMaxInflight.ts'
import {getJudgmentsCapacity} from './getJudgmentsCapacity.ts'
import {enqueueClaimedJudgmentPrompts} from './judgmentDispatchRuntime.ts'
import {getJudgmentEndpointAvailability} from './judgmentEndpointAvailability.ts'
import {getJudgmentJobSqliteService} from './judgmentJobSqliteService.ts'
import {filterRunningJobsByRuntimeMatch, type RunningJudgmentJob} from './judgmentsJobsGetRunningJobs.ts'
import {
  getAndUpdateReadyPrompts,
  getReadyPromptRuntime,
  type PromptRuntime,
  type PromptToProcess,
} from './judgmentsJobsSendToLLM/getAndUpdateReadyPrompts.ts'
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
type ClaimableJobRequest<T> = JobRequestAllocation<T> & {dispatchMode: 'full' | 'probe'; runtime: PromptRuntime}

const schedulerLogger = rateLimitedLogger

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

const getEndpointAvailabilityKey = ({
  baseURL,
  providerConnectionId,
}: {
  baseURL: string
  providerConnectionId: string | null
}): string => {
  return `${providerConnectionId ?? 'unknown'}::${baseURL}`
}

const getDispatchEndpoints = (runtime: PromptRuntime): string[] => {
  return runtime.modelWorkerUrls.length > 0
    ? runtime.modelWorkerUrls.map((url) => {
        return `${url}/v1`
      })
    : [runtime.modelBaseUrl]
}

export const getDispatchAvailability = ({
  providerConnectionId,
  runtime,
}: {
  providerConnectionId: string | null
  runtime: PromptRuntime
}): {dispatchMode: 'full' | 'probe' | 'skip'; status: 'cooldown' | 'healthy' | 'misconfigured' | 'probing'} => {
  const endpointStates = getDispatchEndpoints(runtime).map((baseURL) => {
    return getJudgmentEndpointAvailability({effectiveBaseURL: baseURL, providerConnectionId})
  })
  const hasHealthy = endpointStates.some((state) => {
    return state.status === 'healthy'
  })

  if (hasHealthy) {
    return {dispatchMode: 'full', status: 'healthy'}
  }

  const hasProbeEligibleCooldown = endpointStates.some((state) => {
    return (
      state.status === 'cooldown' && Boolean(state.cooldownExpiresAt) && state.cooldownExpiresAt.getTime() <= Date.now()
    )
  })

  if (hasProbeEligibleCooldown) {
    return {dispatchMode: 'probe', status: 'cooldown'}
  }

  const hasMisconfigured = endpointStates.some((state) => {
    return state.status === 'misconfigured'
  })

  return {dispatchMode: 'skip', status: hasMisconfigured ? 'misconfigured' : 'cooldown'}
}

const logDispatchSkip = ({
  connectionId,
  dispatchStatus,
  label,
  runtime,
}: {
  connectionId: string | null
  dispatchStatus: 'cooldown' | 'misconfigured' | 'probing'
  label: string
  runtime: PromptRuntime
}) => {
  const baseURL = getDispatchEndpoints(runtime)[0] ?? runtime.modelBaseUrl
  schedulerLogger.warn(
    `scheduler:skip:${dispatchStatus}:${getEndpointAvailabilityKey({baseURL, providerConnectionId: connectionId})}`,
    `[capacity:${label}] skipping claims while endpoint is ${dispatchStatus}`,
    {baseURL, connectionId},
  )
}

export const getClaimableRequests = async ({
  allocations,
  label,
}: {
  allocations: ProviderConnectionRequestAllocation<RunningJudgmentJob>[]
  label: string
}): Promise<ClaimableJobRequest<RunningJudgmentJob>[]> => {
  const connectionResults = await Promise.all(
    allocations.map(async (allocation) => {
      const runtimeResults = await Promise.all(
        allocation.jobs.map(async (jobAllocation) => {
          const runtime = await getReadyPromptRuntime(jobAllocation.job.id)
          return runtime ? {...jobAllocation, runtime} : null
        }),
      )
      const jobsWithRuntime = runtimeResults.filter(
        (job): job is JobRequestAllocation<RunningJudgmentJob> & {runtime: PromptRuntime} => {
          return Boolean(job)
        },
      )

      const fullJobs = jobsWithRuntime.flatMap((jobAllocation) => {
        const availability = getDispatchAvailability({
          providerConnectionId: allocation.connectionId,
          runtime: jobAllocation.runtime,
        })
        return availability.dispatchMode === 'full' ? [{...jobAllocation, dispatchMode: 'full' as const}] : []
      })

      if (fullJobs.length > 0) {
        jobsWithRuntime.forEach((jobAllocation) => {
          const availability = getDispatchAvailability({
            providerConnectionId: allocation.connectionId,
            runtime: jobAllocation.runtime,
          })
          if (availability.dispatchMode === 'skip') {
            logDispatchSkip({
              connectionId: allocation.connectionId,
              dispatchStatus: availability.status,
              label,
              runtime: jobAllocation.runtime,
            })
          }
        })

        return fullJobs
      }

      const probeJob = jobsWithRuntime.find((jobAllocation) => {
        return (
          getDispatchAvailability({providerConnectionId: allocation.connectionId, runtime: jobAllocation.runtime})
            .dispatchMode === 'probe'
        )
      })

      if (probeJob) {
        return [{...probeJob, dispatchMode: 'probe' as const, limit: 1}]
      }

      jobsWithRuntime.forEach((jobAllocation) => {
        const availability = getDispatchAvailability({
          providerConnectionId: allocation.connectionId,
          runtime: jobAllocation.runtime,
        })
        logDispatchSkip({
          connectionId: allocation.connectionId,
          dispatchStatus: availability.status === 'healthy' ? 'probing' : availability.status,
          label,
          runtime: jobAllocation.runtime,
        })
      })

      return []
    }),
  )

  return connectionResults.flat()
}

export const processClaimedPromptsByConnection = async ({
  label,
  processPrompt = processPromptWithLLM,
  prompts,
  requeuePrompts = requeueRejectedPrompts,
}: {
  label: string
  processPrompt?: (prompt: PromptToProcess) => Promise<void>
  prompts: PromptToProcess[]
  requeuePrompts?: (prompts: PromptToProcess[]) => Promise<void>
}): Promise<{connectionErrors: number}> => {
  const byConnection = prompts.reduce((state, prompt) => {
    const connectionId = prompt.providerConnectionId ?? prompt.jobId
    return new Map(state).set(connectionId, [...(state.get(connectionId) ?? []), prompt])
  }, new Map<string, PromptToProcess[]>())

  const results = await Promise.all(
    Array.from(byConnection.entries()).map(async ([connectionId, connectionPrompts]) => {
      let fulfilled = 0
      let rejected = 0
      let connectionErrors = 0
      let halted = false
      let requeuedCount = 0

      await connectionPrompts.reduce<Promise<void>>(async (previous, prompt, index) => {
        await previous

        if (halted) {
          return undefined
        }

        const availability = getDispatchAvailability({
          providerConnectionId: prompt.providerConnectionId,
          runtime: {
            modelBaseUrl: prompt.modelBaseUrl,
            modelProvider: prompt.modelProvider,
            modelWorkerUrls: prompt.modelWorkerUrls,
          },
        })

        if (availability.dispatchMode === 'skip') {
          halted = true
          const remainingPrompts = connectionPrompts.slice(index)
          requeuedCount = remainingPrompts.length
          await requeuePrompts(remainingPrompts)
          logDispatchSkip({
            connectionId: prompt.providerConnectionId,
            dispatchStatus: availability.status,
            label,
            runtime: {
              modelBaseUrl: prompt.modelBaseUrl,
              modelProvider: prompt.modelProvider,
              modelWorkerUrls: prompt.modelWorkerUrls,
            },
          })
          return undefined
        }

        try {
          const jitterMs = Math.floor(Math.random() * 1000)
          await new Promise((resolve) => {
            setTimeout(resolve, jitterMs)
          })
          await processPrompt(prompt)
          fulfilled += 1
        } catch (error) {
          rejected += 1
          const isConnectionFailure = error instanceof ConnectionError
          connectionErrors += isConnectionFailure ? 1 : 0

          if (!isConnectionFailure) {
            return undefined
          }

          halted = true
          const remainingPrompts = connectionPrompts.slice(index + 1)
          requeuedCount = remainingPrompts.length
          if (remainingPrompts.length > 0) {
            await requeuePrompts(remainingPrompts)
          }
          schedulerLogger.warn(
            `scheduler:halt:${connectionId}`,
            `[capacity:${label}] stopping queued dispatch after endpoint became unavailable`,
            {connectionId, requeuedCount},
          )
        }
      }, Promise.resolve())

      return {claimedPrompts: connectionPrompts.length, connectionErrors, fulfilled, rejected, requeuedCount}
    }),
  )

  const summary = results.reduce(
    (state, result) => {
      return {
        claimedPrompts: state.claimedPrompts + result.claimedPrompts,
        connectionErrors: state.connectionErrors + result.connectionErrors,
        fulfilled: state.fulfilled + result.fulfilled,
        rejected: state.rejected + result.rejected,
        requeuedCount: state.requeuedCount + result.requeuedCount,
      }
    },
    {claimedPrompts: 0, connectionErrors: 0, fulfilled: 0, rejected: 0, requeuedCount: 0},
  )

  console.log('[llm] Batch complete:', summary)

  if (summary.rejected > 0) {
    schedulerLogger.error(
      'llm:processing-errors',
      `send to LLM: processing errors ${JSON.stringify({
        rejected: summary.rejected,
        connectionErrors: summary.connectionErrors,
        total: summary.claimedPrompts,
        requeuedCount: summary.requeuedCount,
      })}`,
    )
  }

  return {connectionErrors: summary.connectionErrors}
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

  const requestsToSendByConnection = getRequestsToSendByProviderConnection({
    jobs,
    maxRequestsToSend: requestsToSend,
    inFlightCounts,
    readyCounts,
  })
  const requestsToSendByJob = await getClaimableRequests({allocations: requestsToSendByConnection, label})
  console.log(
    `[capacity:${label}] requestsToSendByJob:`,
    requestsToSendByJob.map(({dispatchMode, job, limit}) => {
      return {dispatchMode, jobId: job.id.slice(0, 8), limit}
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

  const enqueueResults = await Promise.all(
    promptsToProcess.map(async (prompts) => {
      return prompts.length > 0
        ? enqueueClaimedJudgmentPrompts({label, prompts})
        : {acceptedCount: 0, rejectedPrompts: []}
    }),
  )

  const rejectedPrompts = enqueueResults.flatMap((result) => {
    return result.rejectedPrompts
  })

  if (rejectedPrompts.length > 0) {
    await requeueRejectedPrompts(rejectedPrompts)
    schedulerLogger.warn(
      'scheduler:dispatch-queue-full',
      `[capacity:${label}] requeued claimed prompts because dispatch queues were full`,
      {rejectedCount: rejectedPrompts.length},
    )
  }
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
