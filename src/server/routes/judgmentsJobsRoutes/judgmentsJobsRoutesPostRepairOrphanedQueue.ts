import {runJudgmentJobAutomaticOrphanedQueueRepairAction} from '../../cron/judgmentsJobs/judgmentJobRepair.ts'

export const judgmentsJobsRoutesPostRepairOrphanedQueue = async ({
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
    data: await runJudgmentJobAutomaticOrphanedQueueRepairAction({claimedBy: body?.claimedBy, jobId: params.id}),
    error: null,
  }
}
