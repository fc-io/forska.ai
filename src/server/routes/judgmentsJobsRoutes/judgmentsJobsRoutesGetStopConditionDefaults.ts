import {getJudgmentJobStopConditionDefaults} from '../../cron/judgmentsJobs/judgmentJobStopConditionDefaults.ts'
import {getJobContext} from './getJobContext.ts'
import {getJudgmentJobsReadDatabase} from './getJudgmentJobsReadDatabase.ts'
import {runJudgmentJobsRead} from './runJudgmentJobsRead.ts'

export const judgmentsJobsRoutesGetStopConditionDefaults = async ({
  params,
  request,
}: {
  params: {id: string}
  request: Request
}) => {
  return runJudgmentJobsRead({
    operation: async () => {
      const db = getJudgmentJobsReadDatabase()
      const {job} = await getJobContext({db, jobId: params.id})
      const defaults = await getJudgmentJobStopConditionDefaults({db, jobId: job.id, projectId: job.projectId})

      return {data: {...defaults, serverNow: new Date().toISOString()}, error: null}
    },
    request,
  })
}
