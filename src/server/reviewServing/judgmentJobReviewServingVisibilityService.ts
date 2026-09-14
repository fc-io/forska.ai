import {getSqlLiteral} from '../services/appQueryHelpers.ts'

type JudgmentJobVisibilityDatabase = {
  queryJson: <T>(statement: string) => Promise<T[]>
  queryJsonBackground?: <T>(statement: string) => Promise<T[]>
}

type CompletedJudgmentJobVisibility = {ackToken: number | null; jobId: string}

const visibilityCandidateBatchSize = 64
let visibilityJobCursor: string | null = null

const jobResultVisibilityComponents = ['llmStatus', 'queue', 'payload'] as const

const getJobResultVisibilityComponentValuesSql = () => {
  return jobResultVisibilityComponents
    .map((component) => {
      return `(${getSqlLiteral(component)})`
    })
    .join(', ')
}

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
  ), required_visibility_component(component) AS (
    SELECT * FROM (VALUES ${getJobResultVisibilityComponentValuesSql()})
  ), pending_result_visibility_work AS (
    SELECT DISTINCT
      candidate.job_id
    FROM candidate_job_visibility candidate
    INNER JOIN app.review_serving_dirty_work dirty_work
      ON dirty_work.project_id = candidate.project_id
      AND dirty_work.source_partition = candidate.source_partition
      AND dirty_work.latest_source_high_water_mark <= candidate.source_high_water_mark
    INNER JOIN required_visibility_component required_component
      ON required_component.component = dirty_work.projection_component
    WHERE dirty_work.status <> 'completed'
  ), invisible_llm_delta AS (
    SELECT DISTINCT
      candidate.job_id
    FROM candidate_job_visibility candidate
    INNER JOIN app.review_change_delta delta
      ON delta.project_id = candidate.project_id
      AND delta.source_partition = candidate.source_partition
      AND delta.source_high_water_mark <= candidate.source_high_water_mark
      AND delta.change_kind IN ('judgment.llm.created', 'judgment.llm.updated')
    WHERE NOT EXISTS (
      SELECT 1
      FROM mart.review_article_judgment_detail_serving_v4 detail
      WHERE detail.project_id = delta.project_id
        AND detail.article_id = delta.article_id
        AND detail.prompt_id = delta.prompt_id
        AND detail.judgment_id = delta.judgment_id
        AND detail.payload_kind = 'llm'
    )
  )
  SELECT
    candidate.job_id AS jobId,
    CAST(
      CASE
        WHEN completed.source_high_water_mark IS NULL
          OR completed.source_high_water_mark < candidate.source_high_water_mark
          THEN NULL
        WHEN pending_result_visibility_work.job_id IS NOT NULL THEN NULL
        WHEN invisible_llm_delta.job_id IS NOT NULL THEN NULL
        ELSE candidate.source_high_water_mark
      END AS INTEGER
    ) AS ackToken
  FROM candidate_job_visibility candidate
  LEFT JOIN app.review_serving_project_dirty_source_watermark completed
    ON completed.project_id = candidate.project_id
    AND completed.source_partition = candidate.source_partition
  LEFT JOIN pending_result_visibility_work
    ON pending_result_visibility_work.job_id = candidate.job_id
  LEFT JOIN invisible_llm_delta
    ON invisible_llm_delta.job_id = candidate.job_id
  ORDER BY candidate.job_id
`
}

export const completedJudgmentJobVisibilitySql = getCompletedJudgmentJobVisibilitySql()

export const publishProjectedJudgmentJobVisibility = async (
  database: JudgmentJobVisibilityDatabase,
  publishAck: (visibility: {ackToken: number; jobId: string}) => Promise<void>,
) => {
  const queryVisibility = database.queryJsonBackground ?? database.queryJson
  const completedVisibility = await queryVisibility<CompletedJudgmentJobVisibility>(
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
