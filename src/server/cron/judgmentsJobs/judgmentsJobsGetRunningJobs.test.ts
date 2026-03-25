import {expect, mock, test} from 'bun:test'

import {filterRunningJobsByRuntimeMatch, type RunningJudgmentJob} from './judgmentsJobsGetRunningJobs.ts'

test('filterRunningJobsByRuntimeMatch filters out jobs with runtime mismatch', async () => {
  const getRuntimeMatch = mock(async ({modelId}: {modelId: string}) => {
    return {message: modelId === 'model-mismatch' ? 'runtime mismatch' : null, ok: modelId !== 'model-mismatch'}
  })
  const jobs: RunningJudgmentJob[] = [
    {
      id: 'job-ok',
      modelId: 'model-ok',
      modelName: 'Qwen/Qwen3.5-35B-A3B',
      modelProvider: 'sglang',
      projectId: 'project-ok',
    },
    {
      id: 'job-mismatch',
      modelId: 'model-mismatch',
      modelName: 'Qwen/Qwen3.5-32B',
      modelProvider: 'sglang',
      projectId: 'project-mismatch',
    },
  ]

  const filtered = await filterRunningJobsByRuntimeMatch(jobs, getRuntimeMatch)

  expect(
    filtered.map((job) => {
      return job.id
    }),
  ).toEqual(['job-ok'])
  expect(getRuntimeMatch).toHaveBeenCalledTimes(2)
})
