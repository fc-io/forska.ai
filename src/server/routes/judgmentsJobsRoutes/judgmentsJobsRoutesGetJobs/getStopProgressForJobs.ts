import {
  getJudgmentJobAdmittedArticleCount,
  getJudgmentJobTotalTokens,
} from '../../../cron/judgmentsJobs/judgmentJobAdmittedArticles.ts'
import type {JudgmentJobSqliteHealthProjectionReader} from '../../../services/judgmentJobSqliteHealthProjectionService.ts'

export const getStopProgressForJobs = async ({
  db,
  jobs,
}: {
  db: JudgmentJobSqliteHealthProjectionReader
  jobs: Array<{id: string; stopAfterArticles: number | null; stopAfterTotalTokens: number | null}>
}) => {
  const progressEntries = await Promise.all(
    jobs.map(async (job) => {
      const [admittedArticleCount, totalTokens] = await Promise.all([
        getJudgmentJobAdmittedArticleCount({db, jobId: job.id, stopAfterArticles: job.stopAfterArticles}),
        job.stopAfterTotalTokens === null ? Promise.resolve(null) : getJudgmentJobTotalTokens({db, jobId: job.id}),
      ])

      return [job.id, {admittedArticleCount, totalTokens}] as const
    }),
  )

  return new Map(progressEntries)
}
