import {expect, mock, test} from 'bun:test'

import type {RunningJudgmentJob} from './judgmentsJobsGetRunningJobs.ts'
import {requeueAndFilterRunningJobs} from './judgmentsJobsSendToLLM.ts'

test('requeues stale sent prompts before runtime filtering', async () => {
  const requeueSentPrompts = mock(async (_params: {jobIds: string[]; serverJobId: string}) => {
    return 0
  })
  const filterJobs = mock(async (jobs: RunningJudgmentJob[]) => {
    return jobs.slice(0, 1)
  })
  const allJobs: RunningJudgmentJob[] = [
    {id: 'job-a', modelId: 'model-a', modelName: 'Model A', modelProvider: 'sglang', projectId: 'project-a'},
    {id: 'job-b', modelId: 'model-b', modelName: 'Model B', modelProvider: 'codex', projectId: 'project-b'},
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
