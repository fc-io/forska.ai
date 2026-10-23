import {
  getJudgmentJobResumeBlockedMessage,
  getJudgmentJobResumeBlockingStopReason,
  getJudgmentJobStopConditions,
} from '../../../utils/judgmentJobStopConditions.ts'
import {
  getJudgmentJobAdmittedArticleCount,
  getJudgmentJobTotalTokens,
} from '../../cron/judgmentsJobs/judgmentJobAdmittedArticles.ts'
import {
  type JudgmentJobStopConditionUpdate,
  mergeJudgmentJobStopConditions,
} from '../../cron/judgmentsJobs/judgmentJobStopConditionInput.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {HttpError} from '../../utils/httpError.ts'
import type {JudgmentJobStopRow} from './getJudgmentJobStopFields.ts'

export const assertJudgmentJobStopConditionsAllowResume = async ({
  jobId,
  update,
}: {
  jobId: string
  update: JudgmentJobStopConditionUpdate
}): Promise<void> => {
  const db = getAppDatabaseService()
  const [row] = await db.queryJson<JudgmentJobStopRow>(`
    SELECT
      stop_after_articles AS stopAfterArticles,
      stop_after_total_tokens AS stopAfterTotalTokens,
      stop_at AS stopAt,
      COALESCE(stop_when_human_answered_done, FALSE) AS stopWhenHumanAnsweredDone
    FROM app.judgment_job
    WHERE id = ${getSqlLiteral(jobId)}
    LIMIT 1
  `)
  const conditions = mergeJudgmentJobStopConditions(getJudgmentJobStopConditions(row ?? {}), update)
  const [admittedArticleCount, totalTokens] = await Promise.all([
    getJudgmentJobAdmittedArticleCount({db, jobId, stopAfterArticles: conditions.stopAfterArticles}),
    conditions.stopAfterTotalTokens === null ? Promise.resolve(null) : getJudgmentJobTotalTokens({db, jobId}),
  ])
  const blockingReason = getJudgmentJobResumeBlockingStopReason({
    conditions,
    now: new Date(),
    progress: {admittedArticleCount, totalTokens},
  })

  if (blockingReason !== null) {
    throw new HttpError(409, getJudgmentJobResumeBlockedMessage(blockingReason))
  }
}
