import {eq} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../db/schema.ts'

type CursorDb = PostgresJsDatabase<typeof schema>

export type JobCursor = {lastDate: Date; lastArticleId: string}

const getCursorFromRow = (row: {lastDate: Date | null; lastArticleId: string | null} | undefined): JobCursor | null => {
  const lastDate = row?.lastDate ?? null
  const lastArticleId = row?.lastArticleId ?? null
  return lastDate && lastArticleId ? {lastDate, lastArticleId} : null
}

export const getJobCursor = async (db: CursorDb, jobId: string): Promise<JobCursor | null> => {
  const rows = await db
    .select({
      lastDate: schema.judgmentsJobs.chCursorLastDate,
      lastArticleId: schema.judgmentsJobs.chCursorLastArticleId,
    })
    .from(schema.judgmentsJobs)
    .where(eq(schema.judgmentsJobs.id, jobId))
    .limit(1)

  return getCursorFromRow(rows[0])
}

export const setJobCursor = async (db: CursorDb, jobId: string, cursor: JobCursor): Promise<void> => {
  await db
    .update(schema.judgmentsJobs)
    .set({chCursorLastDate: cursor.lastDate, chCursorLastArticleId: cursor.lastArticleId})
    .where(eq(schema.judgmentsJobs.id, jobId))
}

export const clearJobCursor = async (db: CursorDb, jobId: string): Promise<void> => {
  await db
    .update(schema.judgmentsJobs)
    .set({chCursorLastDate: null, chCursorLastArticleId: null})
    .where(eq(schema.judgmentsJobs.id, jobId))
}

export const clearAllJobCursors = async (db: CursorDb): Promise<void> => {
  await db.update(schema.judgmentsJobs).set({chCursorLastDate: null, chCursorLastArticleId: null})
}
