import {expect, mock, test} from 'bun:test'

import type {RunningJudgmentJob} from './judgmentsJobsGetRunningJobs.ts'
import {
  getCapacityBuckets,
  getEffectiveProviderCap,
  getRequestsToSendByProviderConnection,
  requeueAndFilterRunningJobs,
} from './judgmentsJobsSendToLLM.ts'

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
      capacity: {maxBurst: 2, maxInflight: 2, workerCount: 2},
      jobIds: ['job-override-a', 'job-override-b'],
      label: 'provider:connection-override',
    },
    {capacity: {maxBurst: 10, maxInflight: 10, workerCount: 1}, jobIds: ['job-default-non-codex'], label: 'non-codex'},
    {capacity: {maxBurst: 4, maxInflight: 4, workerCount: 4}, jobIds: ['job-default-codex'], label: 'codex'},
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

test('caps shared provider connections before splitting claims across jobs', () => {
  const allocations = getRequestsToSendByProviderConnection({
    getCodexDefaultMaxInflight: () => {
      return 4
    },
    getNonCodexCapacity: () => {
      return {maxBurst: 10, maxInflight: 10, workerCount: 1}
    },
    inFlightCounts: new Map([
      ['job-shared-a', 5],
      ['job-shared-b', 3],
      ['job-independent', 0],
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
    readyCounts: new Map([
      ['job-shared-a', 4],
      ['job-shared-b', 4],
      ['job-independent', 5],
    ]),
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

test('lets different provider connections progress under a stricter shared bucket limit', () => {
  const allocations = getRequestsToSendByProviderConnection({
    getCodexDefaultMaxInflight: () => {
      return 4
    },
    getNonCodexCapacity: () => {
      return {maxBurst: 10, maxInflight: 10, workerCount: 1}
    },
    inFlightCounts: new Map([
      ['job-a', 0],
      ['job-b', 0],
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
    readyCounts: new Map([
      ['job-a', 5],
      ['job-b', 5],
    ]),
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
