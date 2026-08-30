import {getSqlLiteral} from '../services/appQueryHelpers.ts'

type JudgmentJobVisibilityDatabase = {queryJson: <T>(statement: string) => Promise<T[]>}

type CompletedJudgmentJobVisibility = {ackToken: number | null; jobId: string}

const visibilityCandidateBatchSize = 64
let visibilityJobCursor: string | null = null

export const getCompletedJudgmentJobVisibilitySql = (afterJobId: string | null = null) => {
  return `
  WITH candidate_job_visibility AS (
    SELECT
      job.id AS job_id,
      job.project_id,
      cursor.source_partition,
      cursor.source_high_water_mark
    FROM app.judgment_job job
    INNER JOIN app.review_delta_reconciliation_cursor cursor
      ON cursor.source_partition = 'judgmentSqliteOutboxImport:' || job.id
    WHERE job.storage_state IN ('active', 'draining')
      ${afterJobId === null ? '' : `AND job.id > ${getSqlLiteral(afterJobId)}`}
    ORDER BY job.id
    LIMIT ${visibilityCandidateBatchSize}
  )
  SELECT
    candidate.job_id AS jobId,
    CAST(
      CASE
        WHEN completed.source_high_water_mark IS NULL
          OR completed.source_high_water_mark < candidate.source_high_water_mark
          THEN NULL
        WHEN refresh.dirty_token IS NULL THEN 0
        WHEN refresh.dirty_token <= refresh.last_completed_dirty_token
          AND NOT EXISTS (
            SELECT 1
            FROM app.project_mart_dirty_materialization_state materialization
            WHERE materialization.project_id = candidate.project_id
              AND materialization.target_dirty_token <= refresh.dirty_token
              AND materialization.materialization_status <> 'completed'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM app.project_mart_dirty_refresh_article_quarantine quarantine
            WHERE quarantine.project_id = candidate.project_id
              AND quarantine.dirty_token <= refresh.dirty_token
              AND quarantine.resolved_at IS NULL
          )
          THEN refresh.last_completed_dirty_token
        ELSE NULL
      END AS INTEGER
    ) AS ackToken
  FROM candidate_job_visibility candidate
  LEFT JOIN app.project_mart_refresh_state refresh
    ON refresh.project_id = candidate.project_id
  LEFT JOIN app.review_serving_project_dirty_source_watermark completed
    ON completed.project_id = candidate.project_id
    AND completed.source_partition = candidate.source_partition
  ORDER BY candidate.job_id
`
}

export const completedJudgmentJobVisibilitySql = getCompletedJudgmentJobVisibilitySql()

export const publishProjectedJudgmentJobVisibility = async (
  database: JudgmentJobVisibilityDatabase,
  publishAck: (visibility: {ackToken: number; jobId: string}) => Promise<void>,
) => {
  const completedVisibility = await database.queryJson<CompletedJudgmentJobVisibility>(
    getCompletedJudgmentJobVisibilitySql(visibilityJobCursor),
  )
  const lastCandidate = completedVisibility.at(-1)

  if (lastCandidate && completedVisibility.length === visibilityCandidateBatchSize) {
    visibilityJobCursor = lastCandidate.jobId
  } else {
    visibilityJobCursor = null
  }

  const publishableVisibility = completedVisibility.filter(
    (visibility): visibility is {ackToken: number; jobId: string} => {
      return visibility.ackToken !== null
    },
  )

  await publishableVisibility.reduce(async (previous, visibility) => {
    await previous
    await publishAck(visibility)
  }, Promise.resolve())

  return publishableVisibility.length
}
