import {eq} from 'drizzle-orm'

import * as schema from '../../../db/schema.ts'
import type {AppDatabase} from '../../utils/getDatabase.ts'

type CursorDb = AppDatabase

export type JobCursor = {lastDate: Date; lastArticleId: string}

const getCursorFromRow = (row: {lastDate: Date | null; lastArticleId: string | null} | undefined): JobCursor | null => {
  const lastDate = row?.lastDate ?? null
  const lastArticleId = row?.lastArticleId ?? null
  return lastDate && lastArticleId ? {lastDate, lastArticleId} : null
}

export const getJobCursor = async (db: CursorDb, jobId: string): Promise<JobCursor | null> => {
  const rows = await db
    .select({
      lastDate: schema.judgmentsJobs.cursorLastCreatedAt,
      lastArticleId: schema.judgmentsJobs.cursorLastArticleId,
    })
    .from(schema.judgmentsJobs)
    .where(eq(schema.judgmentsJobs.id, jobId))
    .limit(1)

  return getCursorFromRow(rows[0])
}

export const setJobCursor = async (db: CursorDb, jobId: string, cursor: JobCursor): Promise<void> => {
  await db
    .update(schema.judgmentsJobs)
    .set({cursorLastCreatedAt: cursor.lastDate, cursorLastArticleId: cursor.lastArticleId})
    .where(eq(schema.judgmentsJobs.id, jobId))
}

export const clearJobCursor = async (db: CursorDb, jobId: string): Promise<void> => {
  await db
    .update(schema.judgmentsJobs)
    .set({cursorLastCreatedAt: null, cursorLastArticleId: null})
    .where(eq(schema.judgmentsJobs.id, jobId))
}

export const clearAllJobCursors = async (db: CursorDb): Promise<void> => {
  await db.update(schema.judgmentsJobs).set({cursorLastCreatedAt: null, cursorLastArticleId: null})
}
