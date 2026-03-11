import {lt} from 'drizzle-orm'

import * as schema from '../../../db/schema.ts'
import type {AppDatabase} from '../../utils/getDatabase.ts'

export const judgmentsJobsCleanupStale = async (db: AppDatabase): Promise<void> => {
  const sixteenMinutesAgo = new Date(Date.now() - 16 * 60 * 1000)

  await db.delete(schema.judgmentsJobsPrompts).where(lt(schema.judgmentsJobsPrompts.updatedAt, sixteenMinutesAgo))
}
