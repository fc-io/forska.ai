import {runJudgmentJobRepairAction} from '../../cron/judgmentsJobs/judgmentJobRepair.ts'

export const judgmentsJobsRoutesPostUnquarantine = async ({params}: {params: {id: string}}) => {
  return {data: await runJudgmentJobRepairAction({action: 'unquarantine', jobId: params.id}), error: null}
}
