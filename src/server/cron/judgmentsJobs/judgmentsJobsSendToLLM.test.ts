import {expect, mock, test} from 'bun:test'

import type {RunningJudgmentJob} from './judgmentsJobsGetRunningJobs.ts'
import {getCapacityBuckets, getEffectiveProviderCap, requeueAndFilterRunningJobs} from './judgmentsJobsSendToLLM.ts'

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
