import {createRateLimitedLogger} from '../../utils/rateLimitedLogger.ts'
import {ConnectionError} from './connectionHealth.ts'
import {getEndpointAvailabilityKey} from './endpointAvailabilityKey.ts'
import {getCodexMaxInflight} from './getCodexMaxInflight.ts'
import {getJudgmentsCapacity} from './getJudgmentsCapacity.ts'
import {
  enqueueJudgeWorkerCompletion,
  flushJudgeWorkerCompletionOutboxForClaim,
  replayJudgeWorkerCompletionOutbox,
  shouldUseJudgeWorkerOwnerHandoff,
} from './judgeWorkerCompletionJournal.ts'
import {
  enqueueClaimedJudgmentPrompts,
  getJudgmentDispatchJobPromptIds,
  getJudgmentDispatchQueueCapacity,
} from './judgmentDispatchRuntime.ts'
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
import {getJudgmentRequestStats} from './judgmentsRequestRuntime.ts'
import {getNormalizedProviderKeyProvider, getProviderKey} from './providerKey.ts'
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
  return getNormalizedProviderKeyProvider(value)
}

const isCodexJob = (job: {modelProvider: string | null}): boolean => {
  return normalizeProvider(job.modelProvider) === 'codex'
}

type Capacity = {maxInflight: number; maxBurst: number; workerCount: number}
type CapacityBucket<T> = {capacity: Capacity; jobs: T[]; label: string}
type JobRequestAllocation<T> = {job: T; limit: number}
type ProviderConnectionRequestAllocation<T> = {connectionId: string; jobs: JobRequestAllocation<T>[]; limit: number}
type ClaimableJobRequest<T> = JobRequestAllocation<T> & {dispatchMode: 'full' | 'probe'; runtime: PromptRuntime}

const schedulerLogger = createRateLimitedLogger({sink: 'file-only', windowMs: 30_000})
const schedulerFailureLogger = createRateLimitedLogger({sink: 'both', windowMs: 30_000})
const sendToLLMComponent = 'judgmentsJobsSendToLLM'
const initialPromptClaimDispatchChunkSize = 16
const promptClaimDispatchChunkSize = 64

const anthropicConnectionWarmupStartedAt = new Map<string, number>()

const isAnthropicJob = (job: {modelProvider: string | null}) => {
  return normalizeProvider(job.modelProvider) === 'anthropic'
}

const getAnthropicWarmupMaxInflight = ({
  configuredMaxInflight,
  providerConnectionId,
}: {
  configuredMaxInflight: number
  providerConnectionId: string | null
}): number => {
  if (!providerConnectionId) {
    return configuredMaxInflight
  }

  const startedAt = anthropicConnectionWarmupStartedAt.get(providerConnectionId) ?? Date.now()

  if (!anthropicConnectionWarmupStartedAt.has(providerConnectionId)) {
    anthropicConnectionWarmupStartedAt.set(providerConnectionId, startedAt)
  }

  const elapsedMs = Math.max(0, Date.now() - startedAt)
  const warmupMaxInflight =
    elapsedMs < 15_000 ? 10 : elapsedMs < 30_000 ? 20 : elapsedMs < 60_000 ? 40 : configuredMaxInflight

  return Math.max(1, Math.min(configuredMaxInflight, warmupMaxInflight))
}

const getCapacityFromMaxInflight = (maxInflightRequests: number): Capacity => {
  const limit = Math.max(1, maxInflightRequests)

  return {maxBurst: limit, maxInflight: limit, workerCount: limit}
}

const getJobProviderKey = (job: RunningJudgmentJob): string => {
  return getProviderKey({
    modelId: job.modelId,
    modelProvider: job.modelProvider,
    providerConnectionId: job.providerConnectionId,
    useOwnerBackedSyntheticProviderId: shouldUseJudgeWorkerOwnerHandoff(),
  })
}

const getPromptProviderKey = (prompt: PromptToProcess): string => {
  return getProviderKey({
    modelId: prompt.modelId,
    modelProvider: prompt.modelProvider,
    providerConnectionId: prompt.providerConnectionId,
    useOwnerBackedSyntheticProviderId: shouldUseJudgeWorkerOwnerHandoff(),
  })
}

const getProviderBucketLabel = (job: RunningJudgmentJob, providerKey: string): string => {
  return providerKey.includes(':') ? providerKey : `${isCodexJob(job) ? 'codex' : 'provider'}:${providerKey}`
}

const getProviderKeyBucketCapacity = ({
  getCodexDefaultMaxInflight,
  getNonCodexCapacity,
  jobs,
}: {
  getCodexDefaultMaxInflight: () => number
  getNonCodexCapacity: (runningJobCount: number) => Capacity
  jobs: RunningJudgmentJob[]
}): Capacity => {
  const [firstJob] = jobs

  return !firstJob
    ? getCapacityFromMaxInflight(1)
    : firstJob.providerConnectionId || firstJob.maxInflightRequests != null || isCodexJob(firstJob)
      ? getCapacityFromMaxInflight(
          getEffectiveProviderCap({getCodexDefaultMaxInflight, getNonCodexCapacity, job: firstJob}).maxInflight,
        )
      : getNonCodexCapacity(jobs.length)
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

export const getEffectiveDispatchProviderCap = ({
  getCodexDefaultMaxInflight = getCodexMaxInflight,
  getNonCodexCapacity = getJudgmentsCapacity,
  job,
}: {
  getCodexDefaultMaxInflight?: () => number
  getNonCodexCapacity?: (runningJobCount: number) => Capacity
  job: RunningJudgmentJob
}): {maxInflight: number; usesFamilyDefault: boolean} => {
  const configuredCap = getEffectiveProviderCap({getCodexDefaultMaxInflight, getNonCodexCapacity, job})

  return isAnthropicJob(job)
    ? {
        maxInflight: getAnthropicWarmupMaxInflight({
          configuredMaxInflight: configuredCap.maxInflight,
          providerConnectionId: job.providerConnectionId,
        }),
        usesFamilyDefault: configuredCap.usesFamilyDefault,
      }
    : configuredCap
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
  const grouped = jobs.reduce((state, job) => {
    const providerKey = getJobProviderKey(job)

    return new Map(state).set(providerKey, [...(state.get(providerKey) ?? []), job])
  }, new Map<string, RunningJudgmentJob[]>())

  return Array.from(grouped.entries()).flatMap(([providerKey, bucketJobs]) => {
    const [firstJob] = bucketJobs

    return firstJob
      ? [
          {
            capacity: getProviderKeyBucketCapacity({getCodexDefaultMaxInflight, getNonCodexCapacity, jobs: bucketJobs}),
            jobs: bucketJobs,
            label: getProviderBucketLabel(firstJob, providerKey),
          },
        ]
      : []
  })
}

const getReadyCountsByJob = async (jobIds: string[]): Promise<Map<string, number>> => {
  if (shouldUseJudgeWorkerOwnerHandoff()) {
    return new Map(
      jobIds.map((jobId) => {
        return [jobId, Number.MAX_SAFE_INTEGER] as const
      }),
    )
  }

  const sqliteService = getJudgmentJobSqliteService()
  const pairs = await Promise.all(
    jobIds.map(async (jobId) => {
      return [jobId, await sqliteService.getReadyCount(jobId)] as const
    }),
  )

  return new Map(pairs)
}

const getRuntimeInFlightCountsByJob = (jobIds: string[]): Map<string, number> => {
  return new Map(
    jobIds.map((jobId) => {
      return [jobId, getJudgmentRequestStats(jobId).inFlight] as const
    }),
  )
}

const getDispatchQueueCapacityByConnection = async (jobs: RunningJudgmentJob[]): Promise<Map<string, number>> => {
  const connectionJobs = Array.from(
    jobs.reduce((state, job) => {
      const providerKey = getJobProviderKey(job)
      return new Map(state).set(providerKey, state.get(providerKey) ?? job)
    }, new Map<string, RunningJudgmentJob>()),
  )

  const capacities = await Promise.all(
    connectionJobs.map(async ([providerKey, job]) => {
      const dispatchProviderCap = getEffectiveDispatchProviderCap({job})

      return [
        providerKey,
        await getJudgmentDispatchQueueCapacity({
          modelId: job.modelId,
          modelProvider: job.modelProvider,
          providerConnectionId: job.providerConnectionId,
          providerMaxInflightRequests: dispatchProviderCap.maxInflight,
          providerUsesFamilyDefault: dispatchProviderCap.usesFamilyDefault,
        }),
      ] as const
    }),
  )

  return new Map(capacities)
}

const requeueRejectedPrompts = async (prompts: PromptToProcess[]) => {
  if (shouldUseJudgeWorkerOwnerHandoff()) {
    await Promise.all(
      prompts.map(async (prompt) => {
        await enqueueJudgeWorkerCompletion({
          articleId: prompt.articleId,
          claimId: prompt.claimId,
          executionSnapshotHash: prompt.executionSnapshotHash,
          executionSnapshotId: prompt.executionSnapshotId,
          jobId: prompt.jobId,
          modelId: prompt.modelId,
          projectId: prompt.projectId,
          promptId: prompt.promptId,
          queueRecordId: prompt.recordId,
          status: 'retry',
          useAbstract: prompt.useAbstract,
          useFulltext: prompt.useFulltext,
          useFulltextNoImages: prompt.useFulltextNoImages,
          useTitle: prompt.useTitle,
        })
        await flushJudgeWorkerCompletionOutboxForClaim(prompt.claimId)
      }),
    )
    return
  }

  const sqliteService = getJudgmentJobSqliteService()

  await Promise.all(
    prompts.map((prompt) => {
      return sqliteService.markPromptAsRetry(prompt.jobId, prompt.recordId)
    }),
  )
}

const getPromptClaimChunkLimit = (limit: number, chunkSize: number): number => {
  const normalizedLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0

  return Math.min(normalizedLimit, chunkSize)
}

const getSteadyPromptClaimChunkLimits = (limit: number): number[] => {
  const chunkLimit = getPromptClaimChunkLimit(limit, promptClaimDispatchChunkSize)

  return chunkLimit <= 0 ? [] : [chunkLimit, ...getSteadyPromptClaimChunkLimits(limit - chunkLimit)]
}

export const getPromptClaimChunkLimits = (limit: number): number[] => {
  const chunkLimit = getPromptClaimChunkLimit(limit, initialPromptClaimDispatchChunkSize)

  return chunkLimit <= 0 ? [] : [chunkLimit, ...getSteadyPromptClaimChunkLimits(limit - chunkLimit)]
}

const enqueueClaimedPromptBatch = async ({
  label,
  prompts,
}: {
  label: string
  prompts: PromptToProcess[]
}): Promise<{acceptedCount: number; rejectedPrompts: PromptToProcess[]}> => {
  const enqueueResult =
    prompts.length > 0 ? await enqueueClaimedJudgmentPrompts({label, prompts}) : {acceptedCount: 0, rejectedPrompts: []}
  const rejectedPrompts = enqueueResult.rejectedPrompts

  if (rejectedPrompts.length > 0) {
    await requeueRejectedPrompts(rejectedPrompts)
    schedulerLogger.warn(
      'scheduler:dispatch-queue-full',
      `[capacity:${label}] requeued claimed prompts because dispatch queues were full`,
      {component: sendToLLMComponent, event: 'dispatchQueueFullRequeue', label, requeuedCount: rejectedPrompts.length},
    )
  }

  return enqueueResult
}

const logPromptClaimFailure = ({
  error,
  jobId,
  label,
  requested,
}: {
  error: unknown
  jobId: string
  label: string
  requested: number
}): void => {
  const safeError =
    error instanceof Error ? {name: error.name, message: error.message, stack: error.stack} : {message: String(error)}

  schedulerFailureLogger.error(
    `llm.claimPrompts.failed.${label}.${jobId}`,
    `[capacity:${label}] failed to claim prompts`,
    {component: sendToLLMComponent, error: safeError, event: 'claimPromptsFailed', jobId, label, requested},
  )
}

const claimAndEnqueuePromptChunk = async ({
  job,
  label,
  limit,
  serverJobId,
}: {
  job: RunningJudgmentJob
  label: string
  limit: number
  serverJobId: string
}): Promise<{fetched: number; rejected: number}> => {
  const providerCap = getEffectiveDispatchProviderCap({job})
  const protectedRecordIds = shouldUseJudgeWorkerOwnerHandoff() ? await getJudgmentDispatchJobPromptIds(job.id) : []
  const prompts = await getAndUpdateReadyPrompts(
    serverJobId,
    job.id,
    limit,
    {
      providerConnectionId: job.providerConnectionId,
      providerMaxInflightRequests: providerCap.maxInflight,
      providerUsesFamilyDefault: providerCap.usesFamilyDefault,
    },
    {protectedRecordIds},
  )
  const enqueueResult = await enqueueClaimedPromptBatch({label, prompts})

  return {fetched: prompts.length, rejected: enqueueResult.rejectedPrompts.length}
}

const claimAndEnqueuePromptChunks = async ({
  chunkLimits,
  job,
  label,
  serverJobId,
}: {
  chunkLimits: number[]
  job: RunningJudgmentJob
  label: string
  serverJobId: string
}): Promise<number> => {
  const [chunkLimit, ...remainingChunkLimits] = chunkLimits

  if (!chunkLimit) {
    return 0
  }

  try {
    const chunkResult = await claimAndEnqueuePromptChunk({job, label, limit: chunkLimit, serverJobId})
    const shouldContinue =
      chunkResult.fetched === chunkLimit && chunkResult.rejected === 0 && remainingChunkLimits.length > 0

    return shouldContinue
      ? chunkResult.fetched
          + (await claimAndEnqueuePromptChunks({chunkLimits: remainingChunkLimits, job, label, serverJobId}))
      : chunkResult.fetched
  } catch (error) {
    logPromptClaimFailure({error, jobId: job.id, label, requested: chunkLimit})
    return 0
  }
}

const claimAndEnqueuePromptRequest = async ({
  job,
  label,
  limit,
  serverJobId,
}: {
  job: RunningJudgmentJob
  label: string
  limit: number
  serverJobId: string
}): Promise<number> => {
  return claimAndEnqueuePromptChunks({chunkLimits: getPromptClaimChunkLimits(limit), job, label, serverJobId})
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
    return getJudgmentEndpointAvailability({
      effectiveBaseURL: baseURL,
      modelProvider: runtime.modelProvider,
      providerConnectionId,
      useOwnerBackedSyntheticProviderId: shouldUseJudgeWorkerOwnerHandoff(),
    })
  })
  const hasHealthy = endpointStates.some((state) => {
    return state.status === 'healthy'
  })

  if (hasHealthy) {
    return {dispatchMode: 'full', status: 'healthy'}
  }

  const hasProbeEligibleCooldown = endpointStates.some((state) => {
    if (state.status !== 'cooldown' || !state.cooldownExpiresAt) {
      return false
    }

    return state.cooldownExpiresAt.getTime() <= Date.now()
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
  const endpointKey = getEndpointAvailabilityKey({
    effectiveBaseURL: baseURL,
    modelProvider: runtime.modelProvider,
    providerConnectionId: connectionId,
    useOwnerBackedSyntheticProviderId: shouldUseJudgeWorkerOwnerHandoff(),
  }).endpointAvailabilityKey

  schedulerLogger.warn(
    `scheduler:skip:${dispatchStatus}:${endpointKey}`,
    `[capacity:${label}] skipping claims while endpoint is ${dispatchStatus}`,
    {baseURL, component: sendToLLMComponent, connectionId, dispatchStatus, event: 'dispatchSkip', label},
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
              dispatchStatus: availability.status === 'healthy' ? 'probing' : availability.status,
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
    const connectionId = getPromptProviderKey(prompt)
    return new Map(state).set(connectionId, [...(state.get(connectionId) ?? []), prompt])
  }, new Map<string, PromptToProcess[]>())

  const getConnectionLaunchLimit = (connectionPrompts: PromptToProcess[]): number => {
    return Math.max(
      1,
      ...connectionPrompts.map((prompt) => {
        return Math.max(1, prompt.providerMaxInflightRequests ?? 1)
      }),
    )
  }

  const results = await Promise.all(
    Array.from(byConnection.entries()).map(async ([connectionId, connectionPrompts]) => {
      let fulfilled = 0
      let rejected = 0
      let connectionErrors = 0
      let halted = false
      let requeuedCount = 0
      let nextPromptIndex = 0
      let haltPromise: Promise<void> | null = null
      const startedPromptIds = new Set<string>()

      const requeueRemainingPrompts = async (): Promise<void> => {
        const remainingPrompts = connectionPrompts.filter((prompt) => {
          return !startedPromptIds.has(prompt.recordId)
        })
        requeuedCount = remainingPrompts.length

        if (remainingPrompts.length > 0) {
          await requeuePrompts(remainingPrompts)
        }
      }

      const haltConnection = (onHalt: () => Promise<void>): Promise<void> => {
        if (haltPromise) {
          return haltPromise
        }

        halted = true
        haltPromise = onHalt().then(() => {
          return requeueRemainingPrompts()
        })

        return haltPromise
      }

      const runWorker = async (): Promise<void> => {
        if (halted) {
          return undefined
        }

        const prompt = connectionPrompts[nextPromptIndex]

        if (!prompt) {
          return undefined
        }

        nextPromptIndex += 1

        const runtime = {
          modelBaseUrl: prompt.modelBaseUrl,
          modelProvider: prompt.modelProvider,
          modelWorkerUrls: prompt.modelWorkerUrls,
        }
        const availability = getDispatchAvailability({providerConnectionId: getPromptProviderKey(prompt), runtime})

        if (availability.dispatchMode === 'skip') {
          await haltConnection(async () => {
            logDispatchSkip({
              connectionId: getPromptProviderKey(prompt),
              dispatchStatus: availability.status === 'healthy' ? 'probing' : availability.status,
              label,
              runtime,
            })
          })
          return undefined
        }

        try {
          startedPromptIds.add(prompt.recordId)
          await processPrompt(prompt)
          fulfilled += 1
        } catch (error) {
          rejected += 1
          const isConnectionFailure = error instanceof ConnectionError
          connectionErrors += isConnectionFailure ? 1 : 0

          if (isConnectionFailure) {
            await haltConnection(async () => {
              schedulerLogger.warn(
                `scheduler:halt:${connectionId}`,
                `[capacity:${label}] stopping queued dispatch after endpoint became unavailable`,
                {component: sendToLLMComponent, connectionId, event: 'connectionHalt', label, requeuedCount},
              )
            })
          }
        }

        return halted ? undefined : runWorker()
      }

      const launchCount = Math.min(connectionPrompts.length, getConnectionLaunchLimit(connectionPrompts))

      await Promise.all(
        Array.from({length: launchCount}).map(async () => {
          await runWorker()
        }),
      )

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

  schedulerLogger.log('llm.batchComplete', '[llm] Batch complete', {
    ...summary,
    component: sendToLLMComponent,
    event: 'batchComplete',
    label,
  })

  if (summary.rejected > 0) {
    schedulerFailureLogger.error('llm:processing-errors', 'send to LLM: processing errors', {
      claimedPrompts: summary.claimedPrompts,
      component: sendToLLMComponent,
      connectionErrors: summary.connectionErrors,
      event: 'processingErrors',
      label,
      rejected: summary.rejected,
      requeuedCount: summary.requeuedCount,
    })
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
  providerQueueCapacities,
  readyCounts,
  runtimeInFlightCounts: _runtimeInFlightCounts,
}: {
  getCodexDefaultMaxInflight?: () => number
  getNonCodexCapacity?: (runningJobCount: number) => Capacity
  jobs: T[]
  maxRequestsToSend: number
  providerQueueCapacities: Map<string, number>
  readyCounts: Map<string, number>
  runtimeInFlightCounts: Map<string, number>
}): ProviderConnectionRequestAllocation<T>[] => {
  const connectionGroups = Array.from(
    jobs.reduce((state, job) => {
      const connectionId = getJobProviderKey(job)
      return new Map(state).set(connectionId, [...(state.get(connectionId) ?? []), job])
    }, new Map<string, T[]>()),
  ).map(([connectionId, connectionJobs]) => {
    const firstJob = connectionJobs[0]
    if (!firstJob) return null

    const providerCap = getProviderKeyBucketCapacity({
      getCodexDefaultMaxInflight,
      getNonCodexCapacity,
      jobs: connectionJobs,
    }).maxInflight
    const ready = connectionJobs.reduce((sum, job) => {
      return sum + (readyCounts.get(job.id) ?? 0)
    }, 0)
    const providerQueueCapacity = providerQueueCapacities.get(connectionId) ?? 0

    return {connectionId, jobs: connectionJobs, limit: Math.max(0, Math.min(ready, providerCap, providerQueueCapacity))}
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
  if (shouldUseJudgeWorkerOwnerHandoff()) {
    return allJobs
  }

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
  const runtimeInFlightCounts = getRuntimeInFlightCountsByJob(jobIds)
  const providerQueueCapacities = await getDispatchQueueCapacityByConnection(jobs)
  const promptsInFlight = Array.from(runtimeInFlightCounts.values()).reduce((sum, count) => {
    return sum + count
  }, 0)
  const targetReservedPrompts = capacity.maxInflight + capacity.maxBurst
  const deficit = Math.max(0, targetReservedPrompts - promptsInFlight)
  const totalQueueCapacity = Array.from(providerQueueCapacities.values()).reduce((sum, count) => {
    return sum + count
  }, 0)
  const requestsToSend = Math.min(deficit, totalQueueCapacity)
  const readyCounts = await getReadyCountsByJob(jobIds)

  if (requestsToSend > 0 || promptsInFlight > capacity.maxInflight * 0.9) {
    const readyCountsObj = Object.fromEntries(readyCounts)
    schedulerLogger.log(`llm.capacity.${label}`, `[capacity:${label}] capacity summary`, {
      component: sendToLLMComponent,
      event: 'capacitySummary',
      requestsToSend,
      promptsInFlight,
      maxInflight: capacity.maxInflight,
      maxBurst: capacity.maxBurst,
      workerCount: capacity.workerCount,
      deficit,
      targetReservedPrompts,
      totalQueueCapacity,
      jobCount: jobs.length,
      label,
      readyCounts: readyCountsObj,
    })
  }

  if (requestsToSend <= 0) return

  const requestsToSendByConnection = getRequestsToSendByProviderConnection({
    jobs,
    maxRequestsToSend: requestsToSend,
    providerQueueCapacities,
    readyCounts,
    runtimeInFlightCounts,
  })
  const requestsToSendByJob = await getClaimableRequests({allocations: requestsToSendByConnection, label})
  schedulerLogger.log(`llm.requestsToSendByJob.${label}`, `[capacity:${label}] requests to send by job`, {
    component: sendToLLMComponent,
    event: 'requestsToSendByJob',
    label,
    requests: requestsToSendByJob.map(({dispatchMode, job, limit}) => {
      return {dispatchMode, jobId: job.id.slice(0, 8), limit}
    }),
  })

  const promptFetchedCounts = await Promise.all(
    requestsToSendByJob.map(({job, limit}) => {
      return claimAndEnqueuePromptRequest({job, label, limit, serverJobId})
    }),
  )
  const expectedPromptsToFetch = requestsToSendByJob.reduce((sum, request) => {
    return sum + request.limit
  }, 0)

  const totalPromptsFetched = promptFetchedCounts.reduce((sum, count) => {
    return sum + count
  }, 0)

  if (totalPromptsFetched !== expectedPromptsToFetch) {
    schedulerFailureLogger.warn(`llm.claimPrompts.mismatch.${label}`, `[capacity:${label}] claim count mismatch`, {
      component: sendToLLMComponent,
      event: 'claimCountMismatch',
      label,
      requested: expectedPromptsToFetch,
      totalPromptsFetched,
    })
  }
}

export const judgmentsJobsSendToLLM = async (
  allJobs: RunningJudgmentJob[],
  serverJobId: string,
  {filterJobs}: {filterJobs?: (jobs: RunningJudgmentJob[]) => Promise<RunningJudgmentJob[]>} = {},
): Promise<void> => {
  if (isRunningJudgmentsJobsSendToLLM) return
  isRunningJudgmentsJobsSendToLLM = true

  try {
    if (shouldUseJudgeWorkerOwnerHandoff()) {
      await replayJudgeWorkerCompletionOutbox()
    }

    const sendableJobs = await requeueAndFilterRunningJobs({allJobs, filterJobs, serverJobId})
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

export const resetDispatchProviderWarmupForTests = (): void => {
  anthropicConnectionWarmupStartedAt.clear()
}
