import {runJudgmentJobRepairAction} from '../../cron/judgmentsJobs/judgmentJobRepair.ts'

export const judgmentsJobsRoutesPostQuarantine = async ({
  params,
  body,
}: {
  params: {id: string}
  body: {reason?: string} | null | undefined
}) => {
  return {
    data: await runJudgmentJobRepairAction({action: 'quarantine', jobId: params.id, reason: body?.reason}),
    error: null,
  }
}
