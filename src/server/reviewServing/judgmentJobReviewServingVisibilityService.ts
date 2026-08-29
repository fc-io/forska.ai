type JudgmentJobVisibilityDatabase = {queryJson: <T>(statement: string) => Promise<T[]>}

type CompletedJudgmentJobVisibility = {ackToken: number; jobId: string}

export const completedJudgmentJobVisibilitySql = `
  SELECT
    split_part(dirty.source_partition, ':', 2) AS jobId,
    CAST(MAX(dirty.latest_source_high_water_mark) AS INTEGER) AS ackToken
  FROM app.review_serving_dirty_work dirty
  INNER JOIN app.judgment_job job
    ON job.id = split_part(dirty.source_partition, ':', 2)
    AND job.storage_state IN ('active', 'draining')
  WHERE dirty.source_partition LIKE 'judgmentSqliteOutboxImport:%'
    AND NOT EXISTS (
      SELECT 1
      FROM app.review_serving_dirty_work pending_work
      WHERE pending_work.source_partition = dirty.source_partition
        AND NOT EXISTS (
          SELECT 1
          FROM app.review_serving_dirty_work_ack completed_ack
          WHERE completed_ack.dirty_work_id = pending_work.dirty_work_id
            AND completed_ack.status = 'completed'
            AND completed_ack.completed_source_high_water_mark >= pending_work.latest_source_high_water_mark
        )
    )
  GROUP BY dirty.source_partition
  ORDER BY dirty.source_partition
`

export const publishProjectedJudgmentJobVisibility = async (
  database: JudgmentJobVisibilityDatabase,
  publishAck: (visibility: CompletedJudgmentJobVisibility) => Promise<void>,
) => {
  const completedVisibility = await database.queryJson<CompletedJudgmentJobVisibility>(
    completedJudgmentJobVisibilitySql,
  )

  await completedVisibility.reduce(async (previous, visibility) => {
    await previous
    await publishAck(visibility)
  }, Promise.resolve())

  return completedVisibility.length
}
