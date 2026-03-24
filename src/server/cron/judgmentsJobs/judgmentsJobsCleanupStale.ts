import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getTimestampLiteral} from '../../services/appQueryHelpers.ts'
import {getJudgmentJobSqliteService} from './judgmentJobSqliteService.ts'

export const judgmentsJobsCleanupStale = async (): Promise<void> => {
  const sixteenMinutesAgo = new Date(Date.now() - 16 * 60 * 1000)

  await getJudgmentJobSqliteService().reapStaleOutboxClaims({staleBefore: sixteenMinutesAgo})
  await getAppDatabaseService().run(`
    DELETE FROM app.judgment_job_prompt
    WHERE updated_at < ${getTimestampLiteral(sixteenMinutesAgo)}
  `)
}
