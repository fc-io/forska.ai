import {getJudgmentJobSqliteService} from '../../cron/judgmentsJobs/judgmentJobSqliteService.ts'
import {createRateLimitedLogger} from '../../utils/rateLimitedLogger.ts'

const failedCloseoutReopenLogger = createRateLimitedLogger({sink: 'both', windowMs: 1_000})

// A resume offers every prompt the judge closed as failed after its retries once more. The re-offer runs
// before the job flips to running, so a failure here leaves the job paused instead of half resumed.
export const reopenFailedCloseoutsOnResume = async (jobId: string): Promise<number> => {
  const reopenedCount = await getJudgmentJobSqliteService().reopenFailedCloseoutsForResume(jobId)

  failedCloseoutReopenLogger.log(
    `judgmentsJobs.failedCloseouts.reopened.${jobId}`,
    `[judgmentsJobs] resume re-offered ${reopenedCount} failed closeout(s)`,
    {component: 'JudgmentsJobsRoutes', event: 'failedCloseoutsReopenedOnResume', jobId, reopenedCount},
  )

  return reopenedCount
}
