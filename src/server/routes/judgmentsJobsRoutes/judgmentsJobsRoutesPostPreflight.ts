import {runJudgmentJobRepairAction} from '../../cron/judgmentsJobs/judgmentJobRepair.ts'

export const judgmentsJobsRoutesPostPreflight = async ({params}: {params: {id: string}}) => {
  return {data: await runJudgmentJobRepairAction({action: 'preflight', jobId: params.id}), error: null}
}
