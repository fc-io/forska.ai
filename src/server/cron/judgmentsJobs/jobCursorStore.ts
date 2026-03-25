import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString, getDateValue, getSqlLiteral} from '../../services/appQueryHelpers.ts'

export type JobCursor = {lastDate: Date; lastArticleId: string}

const getCursorFromRow = (row: {lastDate: unknown; lastArticleId: string | null} | undefined): JobCursor | null => {
  const lastDate = getDateValue(row?.lastDate)
  const lastArticleId = row?.lastArticleId ?? null
  return lastDate && lastArticleId ? {lastDate, lastArticleId} : null
}

export const getJobCursor = async (jobId: string): Promise<JobCursor | null> => {
  const rows = await getAppDatabaseService().queryJson<{lastDate: unknown; lastArticleId: string | null}>(`
    SELECT cursor_last_created_at AS lastDate, cursor_last_article_id AS lastArticleId
    FROM app.judgment_job
    WHERE id = '${escapeSqlString(jobId)}'
    LIMIT 1
  `)

  return getCursorFromRow(rows[0])
}

export const setJobCursor = async (jobId: string, cursor: JobCursor): Promise<void> => {
  await getAppDatabaseService().run(`
    UPDATE app.judgment_job
    SET cursor_last_created_at = ${getSqlLiteral(cursor.lastDate)},
        cursor_last_article_id = ${getSqlLiteral(cursor.lastArticleId)},
        updated_at = current_timestamp
    WHERE id = '${escapeSqlString(jobId)}'
  `)
}

export const clearJobCursor = async (jobId: string): Promise<void> => {
  await getAppDatabaseService().run(`
    UPDATE app.judgment_job
    SET cursor_last_created_at = NULL,
        cursor_last_article_id = NULL,
        updated_at = current_timestamp
    WHERE id = '${escapeSqlString(jobId)}'
  `)
}

export const clearAllJobCursors = async (): Promise<void> => {
  await getAppDatabaseService().run(`
    UPDATE app.judgment_job
    SET cursor_last_created_at = NULL,
        cursor_last_article_id = NULL,
        updated_at = current_timestamp
  `)
}
