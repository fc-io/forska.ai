import {afterEach, expect, mock, test} from 'bun:test'

import {classifyConnectionFailure, ConnectionError, recordConnectionFailure} from './connectionHealth.ts'
import {resetJudgmentEndpointAvailabilityForTests} from './judgmentEndpointAvailability.ts'
import {
  getCapacityBuckets,
  getDispatchAvailability,
  getEffectiveDispatchProviderCap,
  getEffectiveProviderCap,
  getPromptClaimChunkLimits,
  getPromptClaimDispatchChunkLimits,
  getPromptClaimDispatchRequestedCount,
  getRequestsToSendByProviderConnection,
  processClaimedPromptsByConnection,
  requeueAndFilterRunningJobs,
  resetDispatchProviderWarmupForTests,
  shouldWarnPromptClaimCountMismatch,
} from './judgmentsJobsSendToLLM.ts'

type PromptToProcess = import('./judgmentsJobsSendToLLM/getAndUpdateReadyPrompts.ts').PromptToProcess
type RunningJudgmentJob = import('./judgmentsJobsGetRunningJobs.ts').RunningJudgmentJob

const realDateNow = Date.now

const createPrompt = (overrides: Partial<PromptToProcess> = {}): PromptToProcess => {
  return {
    articleId: 'article-a',
    claimId: 'claim-a',
    executionSnapshotHash: 'snapshot-hash-a',
    executionSnapshotId: 'snapshot-a',
    jobId: 'job-a',
    modelBaseUrl: 'http://runtime.test/v1',
    modelId: 'model-a',
    modelMetadataJson: null,
    modelName: 'Model A',
    modelProvider: 'openai',
    modelSecretRef: null,
    modelVersion: null,
    modelWorkerUrls: [],
    projectId: 'project-a',
    promptId: 'prompt-a',
    providerConnectionId: 'connection-a',
    providerMaxInflightRequests: 1,
    providerUsesFamilyDefault: false,
    recordId: 'record-a',
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
    ...overrides,
  }
}

afterEach(() => {
  resetDispatchProviderWarmupForTests()
  resetJudgmentEndpointAvailabilityForTests()
  Date.now = realDateNow
})

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

test('requeues stale sent prompts before runtime filtering', async () => {
  const requeueSentPrompts = mock(async (_params: {jobIds: string[]; serverJobId: string}) => {
    return 0
  })
  const filterJobs = mock(async (jobs: RunningJudgmentJob[]) => {
    return jobs.slice(0, 1)
  })
  const allJobs: RunningJudgmentJob[] = [
    {
      id: 'job-a',
      maxInflightRequests: null,
      modelId: 'model-a',
      modelName: 'Model A',
      modelProvider: 'sglang',
      projectId: 'project-a',
      providerConnectionId: 'connection-a',
    },
    {
      id: 'job-b',
      maxInflightRequests: null,
      modelId: 'model-b',
      modelName: 'Model B',
      modelProvider: 'codex',
      projectId: 'project-b',
      providerConnectionId: 'connection-b',
    },
  ]
  const [firstJob] = allJobs

  const sendableJobs = await requeueAndFilterRunningJobs({
    allJobs,
    filterJobs,
    requeueSentPrompts,
    serverJobId: 'server-job-current',
  })

  expect(requeueSentPrompts).toHaveBeenCalledWith({jobIds: ['job-a', 'job-b'], serverJobId: 'server-job-current'})
  expect(filterJobs).toHaveBeenCalledWith(allJobs)
  expect(sendableJobs).toEqual(firstJob ? [firstJob] : [])
})

test('judge-worker owner-backed dispatch skips local requeue and runtime filtering', async () => {
  const previousServerRole = process.env.SERVER_ROLE
  const requeueSentPrompts = mock(async (_params: {jobIds: string[]; serverJobId: string}) => {
    return 0
  })
  const filterJobs = mock(async (_jobs: RunningJudgmentJob[]) => {
    return []
  })
  const allJobs: RunningJudgmentJob[] = [
    {
      id: 'job-owner-backed',
      maxInflightRequests: 20,
      modelId: 'model-owner-backed',
      modelName: 'Model Owner Backed',
      modelProvider: 'codex',
      projectId: 'project-owner-backed',
      providerConnectionId: 'connection-owner-backed',
      quarantineReason: null,
      storageState: 'active',
    },
  ]

  process.env.SERVER_ROLE = 'judge-worker'

  try {
    const sendableJobs = await requeueAndFilterRunningJobs({
      allJobs,
      filterJobs,
      requeueSentPrompts,
      serverJobId: 'server-job-current',
    })

    expect(sendableJobs).toEqual(allJobs)
    expect(requeueSentPrompts).not.toHaveBeenCalled()
    expect(filterJobs).not.toHaveBeenCalled()
  } finally {
    if (previousServerRole === undefined) {
      delete process.env.SERVER_ROLE
    }

    if (previousServerRole !== undefined) {
      process.env.SERVER_ROLE = previousServerRole
    }
  }
})

test('groups jobs with saved provider inflight overrides by connection', () => {
  const buckets = getCapacityBuckets({
    getCodexDefaultMaxInflight: () => {
      return 4
    },
    getNonCodexCapacity: (runningJobCount) => {
      return {maxBurst: runningJobCount * 10, maxInflight: runningJobCount * 10, workerCount: runningJobCount}
    },
    jobs: [
      {
        id: 'job-default-non-codex',
        maxInflightRequests: null,
        modelId: 'model-default-non-codex',
        modelName: 'Model Default Non Codex',
        modelProvider: 'sglang',
        projectId: 'project-default-non-codex',
        providerConnectionId: 'connection-default-non-codex',
      },
      {
        id: 'job-override-a',
        maxInflightRequests: 2,
        modelId: 'model-override-a',
        modelName: 'Model Override A',
        modelProvider: 'sglang',
        projectId: 'project-override-a',
        providerConnectionId: 'connection-override',
      },
      {
        id: 'job-override-b',
        maxInflightRequests: 2,
        modelId: 'model-override-b',
        modelName: 'Model Override B',
        modelProvider: 'sglang',
        projectId: 'project-override-b',
        providerConnectionId: 'connection-override',
      },
      {
        id: 'job-default-codex',
        maxInflightRequests: null,
        modelId: 'model-default-codex',
        modelName: 'Model Default Codex',
        modelProvider: 'codex',
        projectId: 'project-default-codex',
        providerConnectionId: 'connection-default-codex',
      },
    ],
  })

  expect(
    buckets.map((bucket) => {
      return {
        capacity: bucket.capacity,
        jobIds: bucket.jobs.map((job) => {
          return job.id
        }),
        label: bucket.label,
      }
    }),
  ).toEqual([
    {
      capacity: {maxBurst: 10, maxInflight: 10, workerCount: 10},
      jobIds: ['job-default-non-codex'],
      label: 'provider:connection-default-non-codex',
    },
    {
      capacity: {maxBurst: 2, maxInflight: 2, workerCount: 2},
      jobIds: ['job-override-a', 'job-override-b'],
      label: 'provider:connection-override',
    },
    {
      capacity: {maxBurst: 4, maxInflight: 4, workerCount: 4},
      jobIds: ['job-default-codex'],
      label: 'codex:connection-default-codex',
    },
  ])
})

test('getEffectiveProviderCap preserves codex family defaults when no override is saved', () => {
  expect(
    getEffectiveProviderCap({
      getCodexDefaultMaxInflight: () => {
        return 4
      },
      getNonCodexCapacity: () => {
        return {maxBurst: 9, maxInflight: 9, workerCount: 3}
      },
      job: {
        id: 'job-codex-default',
        maxInflightRequests: null,
        modelId: 'model-codex-default',
        modelName: 'Model Codex Default',
        modelProvider: 'codex',
        projectId: 'project-codex-default',
        providerConnectionId: 'connection-codex-default',
      },
    }),
  ).toEqual({maxInflight: 4, usesFamilyDefault: true})
})

test('getEffectiveProviderCap preserves non-codex family defaults when no override is saved', () => {
  expect(
    getEffectiveProviderCap({
      getCodexDefaultMaxInflight: () => {
        return 4
      },
      getNonCodexCapacity: () => {
        return {maxBurst: 9, maxInflight: 9, workerCount: 3}
      },
      job: {
        id: 'job-provider-default',
        maxInflightRequests: null,
        modelId: 'model-provider-default',
        modelName: 'Model Provider Default',
        modelProvider: 'sglang',
        projectId: 'project-provider-default',
        providerConnectionId: 'connection-provider-default',
      },
    }),
  ).toEqual({maxInflight: 9, usesFamilyDefault: true})
})

test('getEffectiveProviderCap prefers the saved provider override', () => {
  expect(
    getEffectiveProviderCap({
      getCodexDefaultMaxInflight: () => {
        return 4
      },
      getNonCodexCapacity: () => {
        return {maxBurst: 9, maxInflight: 9, workerCount: 3}
      },
      job: {
        id: 'job-provider-override',
        maxInflightRequests: 2,
        modelId: 'model-provider-override',
        modelName: 'Model Provider Override',
        modelProvider: 'sglang',
        projectId: 'project-provider-override',
        providerConnectionId: 'connection-provider-override',
      },
    }),
  ).toEqual({maxInflight: 2, usesFamilyDefault: false})
})

test('getEffectiveDispatchProviderCap ramps Anthropic connection overrides during the first minute', () => {
  let now = 1_000
  Date.now = () => {
    return now
  }

  const job: RunningJudgmentJob = {
    id: 'job-anthropic-warmup',
    maxInflightRequests: 80,
    modelId: 'model-anthropic-warmup',
    modelName: 'claude-opus-4-7',
    modelProvider: 'anthropic',
    projectId: 'project-anthropic-warmup',
    providerConnectionId: 'connection-anthropic-warmup',
    quarantineReason: null,
    storageState: 'active',
  }

  expect(getEffectiveDispatchProviderCap({job})).toEqual({maxInflight: 10, usesFamilyDefault: false})

  now += 15_000
  expect(getEffectiveDispatchProviderCap({job})).toEqual({maxInflight: 20, usesFamilyDefault: false})

  now += 15_000
  expect(getEffectiveDispatchProviderCap({job})).toEqual({maxInflight: 40, usesFamilyDefault: false})

  now += 15_000
  expect(getEffectiveDispatchProviderCap({job})).toEqual({maxInflight: 40, usesFamilyDefault: false})

  now += 15_000
  expect(getEffectiveDispatchProviderCap({job})).toEqual({maxInflight: 80, usesFamilyDefault: false})
})

test('getEffectiveDispatchProviderCap leaves non-Anthropic overrides unchanged', () => {
  expect(
    getEffectiveDispatchProviderCap({
      getCodexDefaultMaxInflight: () => {
        return 4
      },
      getNonCodexCapacity: () => {
        return {maxBurst: 9, maxInflight: 9, workerCount: 3}
      },
      job: {
        id: 'job-provider-override-dispatch',
        maxInflightRequests: 80,
        modelId: 'model-provider-override-dispatch',
        modelName: 'Model Provider Override Dispatch',
        modelProvider: 'sglang',
        projectId: 'project-provider-override-dispatch',
        providerConnectionId: 'connection-provider-override-dispatch',
        quarantineReason: null,
        storageState: 'active',
      },
    }),
  ).toEqual({maxInflight: 80, usesFamilyDefault: false})
})

test('caps shared provider connections before splitting claims across jobs', () => {
  const allocations = getRequestsToSendByProviderConnection({
    providerQueueCapacities: new Map([
      ['connection-shared', 2],
      ['connection-independent', 5],
    ]),
    readyCounts: new Map([
      ['job-shared-a', 4],
      ['job-shared-b', 4],
      ['job-independent', 5],
    ]),
    jobs: [
      {
        id: 'job-shared-a',
        maxInflightRequests: null,
        modelId: 'model-shared-a',
        modelName: 'Model Shared A',
        modelProvider: 'sglang',
        projectId: 'project-shared-a',
        providerConnectionId: 'connection-shared',
      },
      {
        id: 'job-shared-b',
        maxInflightRequests: null,
        modelId: 'model-shared-b',
        modelName: 'Model Shared B',
        modelProvider: 'sglang',
        projectId: 'project-shared-b',
        providerConnectionId: 'connection-shared',
      },
      {
        id: 'job-independent',
        maxInflightRequests: null,
        modelId: 'model-independent',
        modelName: 'Model Independent',
        modelProvider: 'sglang',
        projectId: 'project-independent',
        providerConnectionId: 'connection-independent',
      },
    ],
    maxRequestsToSend: 20,
  })

  const limitsByConnection = new Map(
    allocations.map((allocation) => {
      return [
        allocation.connectionId,
        allocation.jobs.reduce((sum, job) => {
          return sum + job.limit
        }, 0),
      ] as const
    }),
  )

  expect(limitsByConnection.get('connection-shared')).toBe(2)
  expect(limitsByConnection.get('connection-independent')).toBe(5)
})

test('caps shared codex provider connections by the saved override before splitting claims across jobs', () => {
  const allocations = getRequestsToSendByProviderConnection({
    providerQueueCapacities: new Map([
      ['connection-codex-shared', 1],
      ['connection-codex-other', 4],
    ]),
    readyCounts: new Map([
      ['job-codex-shared-a', 4],
      ['job-codex-shared-b', 4],
      ['job-codex-other', 4],
    ]),
    jobs: [
      {
        id: 'job-codex-shared-a',
        maxInflightRequests: 2,
        modelId: 'model-codex-shared-a',
        modelName: 'Model Codex Shared A',
        modelProvider: 'codex',
        projectId: 'project-codex-shared-a',
        providerConnectionId: 'connection-codex-shared',
      },
      {
        id: 'job-codex-shared-b',
        maxInflightRequests: 2,
        modelId: 'model-codex-shared-b',
        modelName: 'Model Codex Shared B',
        modelProvider: 'codex',
        projectId: 'project-codex-shared-b',
        providerConnectionId: 'connection-codex-shared',
      },
      {
        id: 'job-codex-other',
        maxInflightRequests: null,
        modelId: 'model-codex-other',
        modelName: 'Model Codex Other',
        modelProvider: 'codex',
        projectId: 'project-codex-other',
        providerConnectionId: 'connection-codex-other',
      },
    ],
    maxRequestsToSend: 10,
  })

  const limitsByConnection = new Map(
    allocations.map((allocation) => {
      return [
        allocation.connectionId,
        allocation.jobs.reduce((sum, job) => {
          return sum + job.limit
        }, 0),
      ] as const
    }),
  )

  expect(limitsByConnection.get('connection-codex-shared')).toBe(1)
  expect(limitsByConnection.get('connection-codex-other')).toBe(4)
})

test('lets different provider connections progress under a stricter shared bucket limit', () => {
  const allocations = getRequestsToSendByProviderConnection({
    providerQueueCapacities: new Map([
      ['connection-a', 5],
      ['connection-b', 5],
    ]),
    readyCounts: new Map([
      ['job-a', 5],
      ['job-b', 5],
    ]),
    jobs: [
      {
        id: 'job-a',
        maxInflightRequests: null,
        modelId: 'model-a',
        modelName: 'Model A',
        modelProvider: 'sglang',
        projectId: 'project-a',
        providerConnectionId: 'connection-a',
      },
      {
        id: 'job-b',
        maxInflightRequests: null,
        modelId: 'model-b',
        modelName: 'Model B',
        modelProvider: 'sglang',
        projectId: 'project-b',
        providerConnectionId: 'connection-b',
      },
    ],
    maxRequestsToSend: 2,
  })

  expect(allocations).toHaveLength(2)
  expect(
    allocations.reduce((sum, allocation) => {
      return (
        sum
        + allocation.jobs.reduce((jobSum, job) => {
          return jobSum + job.limit
        }, 0)
      )
    }, 0),
  ).toBe(2)
  expect(
    allocations.every((allocation) => {
      return allocation.jobs.some((job) => {
        return job.limit > 0
      })
    }),
  ).toBe(true)
})

test('tops up from free dispatcher capacity instead of treating claimed backlog as running', () => {
  const allocations = getRequestsToSendByProviderConnection({
    jobs: [
      {
        id: 'job-a',
        maxInflightRequests: 2,
        modelId: 'model-a',
        modelName: 'Model A',
        modelProvider: 'openai',
        projectId: 'project-a',
        providerConnectionId: 'connection-a',
      },
    ],
    maxRequestsToSend: 10,
    providerQueueCapacities: new Map([['connection-a', 1]]),
    readyCounts: new Map([['job-a', 5]]),
  })

  expect(allocations).toEqual([
    {
      connectionId: 'connection-a',
      jobs: [
        {
          job: {
            id: 'job-a',
            maxInflightRequests: 2,
            modelId: 'model-a',
            modelName: 'Model A',
            modelProvider: 'openai',
            projectId: 'project-a',
            providerConnectionId: 'connection-a',
          },
          limit: 1,
        },
      ],
      limit: 1,
    },
  ])
})

test('claims against dispatcher queue headroom even when a live request is already running', () => {
  const allocations = getRequestsToSendByProviderConnection({
    jobs: [
      {
        id: 'job-a',
        maxInflightRequests: 2,
        modelId: 'model-a',
        modelName: 'Model A',
        modelProvider: 'openai',
        projectId: 'project-a',
        providerConnectionId: 'connection-a',
      },
    ],
    maxRequestsToSend: 10,
    providerQueueCapacities: new Map([['connection-a', 2]]),
    readyCounts: new Map([['job-a', 5]]),
  })

  expect(allocations[0]?.limit).toBe(2)
  expect(allocations[0]?.jobs[0]?.limit).toBe(2)
})

test('fills dispatcher reserve above the live provider cap', () => {
  const allocations = getRequestsToSendByProviderConnection({
    jobs: [
      {
        id: 'job-a',
        maxInflightRequests: 3,
        modelId: 'model-a',
        modelName: 'Model A',
        modelProvider: 'sglang',
        projectId: 'project-a',
        providerConnectionId: 'connection-a',
      },
    ],
    maxRequestsToSend: 10,
    providerQueueCapacities: new Map([['connection-a', 6]]),
    readyCounts: new Map([['job-a', 10]]),
  })

  expect(allocations[0]?.limit).toBe(6)
  expect(allocations[0]?.jobs[0]?.limit).toBe(6)
})

test('splits large prompt claims into dispatch chunks', () => {
  expect(getPromptClaimChunkLimits(0)).toEqual([])
  expect(getPromptClaimChunkLimits(33)).toEqual([16, 17])
  expect(getPromptClaimChunkLimits(145)).toEqual([16, 64, 64, 1])
})

test('caps owner-backed prompt claim chunks per dispatch pass', () => {
  expect(getPromptClaimDispatchChunkLimits({limit: 600, ownerBacked: true})).toEqual([32, 64, 64, 64, 64])
  expect(getPromptClaimDispatchChunkLimits({limit: 145, ownerBacked: false})).toEqual([16, 64, 64, 1])
  expect(getPromptClaimDispatchRequestedCount({limit: 600, ownerBacked: true})).toBe(288)
  expect(getPromptClaimDispatchRequestedCount({limit: 145, ownerBacked: false})).toBe(145)
})

test('does not warn when prompt claim fetches fewer rows than requested', () => {
  expect(shouldWarnPromptClaimCountMismatch({fetched: 0, requested: 5})).toBe(false)
  expect(shouldWarnPromptClaimCountMismatch({fetched: 5, requested: 5})).toBe(false)
  expect(shouldWarnPromptClaimCountMismatch({fetched: 6, requested: 5})).toBe(true)
})

test('dispatch availability skips 404 misroutes during cooldown, probes once after expiry, and skips misconfigured endpoints', () => {
  const providerConnectionId = 'connection-gated'
  const runtime = {modelBaseUrl: 'http://availability.test/v1', modelProvider: 'openai', modelWorkerUrls: []}
  let now = 1_000
  Date.now = () => {
    return now
  }

  const cooldownFailure = classifyConnectionFailure({
    context: {effectiveBaseURL: runtime.modelBaseUrl, endpointPath: '/v1/chat/completions', providerKind: 'openai'},
    error: {status: 404},
  })
  recordConnectionFailure({effectiveBaseURL: runtime.modelBaseUrl, failure: cooldownFailure, providerConnectionId})

  expect(getDispatchAvailability({providerConnectionId, runtime})).toEqual({dispatchMode: 'skip', status: 'cooldown'})

  now += 30_001

  expect(getDispatchAvailability({providerConnectionId, runtime})).toEqual({dispatchMode: 'probe', status: 'cooldown'})

  resetJudgmentEndpointAvailabilityForTests()

  const misconfiguredFailure = classifyConnectionFailure({
    context: {effectiveBaseURL: runtime.modelBaseUrl, endpointPath: '/v1/chat/completions', providerKind: 'openai'},
    error: {status: 405},
  })
  recordConnectionFailure({effectiveBaseURL: runtime.modelBaseUrl, failure: misconfiguredFailure, providerConnectionId})

  expect(getDispatchAvailability({providerConnectionId, runtime})).toEqual({
    dispatchMode: 'skip',
    status: 'misconfigured',
  })
})

test('requeues not-yet-started prompts for a connection after a connection error', async () => {
  const firstPrompt = createPrompt()
  const secondPrompt = createPrompt({articleId: 'article-b', recordId: 'record-b'})
  const processed: string[] = []
  const requeuePrompts = mock(async (_prompts: PromptToProcess[]) => {
    return undefined
  })

  const error = new ConnectionError(
    'endpoint unavailable',
    firstPrompt.modelBaseUrl,
    classifyConnectionFailure({
      context: {
        effectiveBaseURL: firstPrompt.modelBaseUrl,
        endpointPath: '/v1/chat/completions',
        providerKind: 'openai',
      },
      error: {status: 503},
    }),
  )

  await processClaimedPromptsByConnection({
    label: 'test',
    processPrompt: async (prompt) => {
      processed.push(prompt.recordId)
      if (prompt.recordId === firstPrompt.recordId) {
        throw error
      }
    },
    prompts: [firstPrompt, secondPrompt],
    requeuePrompts,
  })

  expect(processed).toEqual(['record-a'])
  expect(requeuePrompts).toHaveBeenCalledWith([secondPrompt])
})

test('prompt/content errors do not pause the whole provider connection', async () => {
  const firstPrompt = createPrompt()
  const secondPrompt = createPrompt({articleId: 'article-b', recordId: 'record-b'})
  const processed: string[] = []
  const requeuePrompts = mock(async (_prompts: PromptToProcess[]) => {
    return undefined
  })

  await processClaimedPromptsByConnection({
    label: 'test',
    processPrompt: async (prompt) => {
      processed.push(prompt.recordId)

      if (prompt.recordId === firstPrompt.recordId) {
        throw new Error('prompt validation failed: status=422')
      }
    },
    prompts: [firstPrompt, secondPrompt],
    requeuePrompts,
  })

  expect(processed).toEqual(['record-a', 'record-b'])
  expect(requeuePrompts).not.toHaveBeenCalled()
})

test('Codex transient prompt errors do not pause the whole provider connection', async () => {
  const firstPrompt = createPrompt({
    modelBaseUrl: 'codex://app-server',
    modelProvider: 'codex',
    providerConnectionId: null,
  })
  const secondPrompt = createPrompt({
    articleId: 'article-b',
    modelBaseUrl: 'codex://app-server',
    modelProvider: 'codex',
    providerConnectionId: null,
    recordId: 'record-b',
  })
  const processed: string[] = []
  const requeuePrompts = mock(async (_prompts: PromptToProcess[]) => {
    return undefined
  })

  await processClaimedPromptsByConnection({
    label: 'test',
    processPrompt: async (prompt) => {
      processed.push(prompt.recordId)

      if (prompt.recordId === firstPrompt.recordId) {
        throw Object.assign(new Error('The operation timed out.'), {code: 'codex_transient_turn_failure'})
      }
    },
    prompts: [firstPrompt, secondPrompt],
    requeuePrompts,
  })

  expect(processed).toEqual(['record-a', 'record-b'])
  expect(requeuePrompts).not.toHaveBeenCalled()
})

test('launches claimed prompts in bounded parallel per connection', async () => {
  const firstRelease = (() => {
    let resolve: () => void = () => {
      return undefined
    }
    const promise = new Promise<void>((nextResolve) => {
      resolve = nextResolve
    })

    return {promise, resolve}
  })()
  const secondRelease = (() => {
    let resolve: () => void = () => {
      return undefined
    }
    const promise = new Promise<void>((nextResolve) => {
      resolve = nextResolve
    })

    return {promise, resolve}
  })()
  const thirdRelease = (() => {
    let resolve: () => void = () => {
      return undefined
    }
    const promise = new Promise<void>((nextResolve) => {
      resolve = nextResolve
    })

    return {promise, resolve}
  })()
  const started: string[] = []
  const processPrompt = mock(async (prompt: PromptToProcess) => {
    started.push(prompt.recordId)

    return prompt.recordId === 'record-a'
      ? firstRelease.promise
      : prompt.recordId === 'record-b'
        ? secondRelease.promise
        : thirdRelease.promise
  })

  const processing = processClaimedPromptsByConnection({
    label: 'test',
    processPrompt,
    prompts: [
      createPrompt({providerMaxInflightRequests: 2, recordId: 'record-a'}),
      createPrompt({articleId: 'article-b', providerMaxInflightRequests: 2, recordId: 'record-b'}),
      createPrompt({articleId: 'article-c', providerMaxInflightRequests: 2, recordId: 'record-c'}),
    ],
  })

  await flush()

  expect(started.includes('record-a')).toBe(true)
  expect(started.includes('record-b')).toBe(true)
  expect(started).not.toContain('record-c')

  firstRelease.resolve()
  await flush()

  expect(started).toContain('record-c')

  secondRelease.resolve()
  thirdRelease.resolve()
  await processing
})

test('connection halts requeue only prompts that never started launch', async () => {
  const secondRelease = (() => {
    let resolve: () => void = () => {
      return undefined
    }
    const promise = new Promise<void>((nextResolve) => {
      resolve = nextResolve
    })

    return {promise, resolve}
  })()
  const requeuePrompts = mock(async (_prompts: PromptToProcess[]) => {
    return undefined
  })
  const started: string[] = []
  const firstPrompt = createPrompt({providerMaxInflightRequests: 2, recordId: 'record-a'})
  const secondPrompt = createPrompt({articleId: 'article-b', providerMaxInflightRequests: 2, recordId: 'record-b'})
  const thirdPrompt = createPrompt({articleId: 'article-c', providerMaxInflightRequests: 2, recordId: 'record-c'})
  const error = new ConnectionError(
    'endpoint unavailable',
    firstPrompt.modelBaseUrl,
    classifyConnectionFailure({
      context: {
        effectiveBaseURL: firstPrompt.modelBaseUrl,
        endpointPath: '/v1/chat/completions',
        providerKind: 'openai',
      },
      error: {status: 503},
    }),
  )

  const processing = processClaimedPromptsByConnection({
    label: 'test',
    processPrompt: async (prompt) => {
      started.push(prompt.recordId)

      if (prompt.recordId === firstPrompt.recordId) {
        await flush()
        throw error
      }

      if (prompt.recordId === secondPrompt.recordId) {
        await secondRelease.promise
      }
    },
    prompts: [firstPrompt, secondPrompt, thirdPrompt],
    requeuePrompts,
  })

  await flush()

  expect(started).toContain('record-a')
  expect(started).toContain('record-b')
  expect(started).not.toContain('record-c')

  secondRelease.resolve()
  await processing

  expect(requeuePrompts).toHaveBeenCalledWith([thirdPrompt])
})

test('requeues remaining claimed prompts when endpoint availability flips before launch', async () => {
  const firstPrompt = createPrompt()
  const secondPrompt = createPrompt({articleId: 'article-b', recordId: 'record-b'})
  const processed: string[] = []
  const requeuePrompts = mock(async (_prompts: PromptToProcess[]) => {
    return undefined
  })

  await processClaimedPromptsByConnection({
    label: 'test',
    processPrompt: async (prompt) => {
      processed.push(prompt.recordId)

      if (prompt.recordId === firstPrompt.recordId) {
        const failure = classifyConnectionFailure({
          context: {
            effectiveBaseURL: prompt.modelBaseUrl,
            endpointPath: '/v1/chat/completions',
            providerKind: 'openai',
          },
          error: {status: 503},
        })
        recordConnectionFailure({
          effectiveBaseURL: prompt.modelBaseUrl,
          failure,
          providerConnectionId: prompt.providerConnectionId,
        })
      }
    },
    prompts: [firstPrompt, secondPrompt],
    requeuePrompts,
  })

  expect(processed).toEqual(['record-a'])
  expect(requeuePrompts).toHaveBeenCalledWith([secondPrompt])
})
