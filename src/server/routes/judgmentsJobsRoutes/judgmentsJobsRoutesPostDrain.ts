import {runJudgmentJobRepairAction} from '../../cron/judgmentsJobs/judgmentJobRepair.ts'

export const judgmentsJobsRoutesPostDrain = async ({
  params,
  body,
}: {
  params: {id: string}
  body:
    | {claimedBy?: string; systemSqliteFallbackSteps?: Array<'checkpoint' | 'diagnostic' | 'export'>}
    | null
    | undefined
}) => {
  return {
    data: await runJudgmentJobRepairAction({
      action: 'drain',
      claimedBy: body?.claimedBy,
      jobId: params.id,
      systemSqliteFallbackSteps: body?.systemSqliteFallbackSteps,
    }),
    error: null,
  }
}
