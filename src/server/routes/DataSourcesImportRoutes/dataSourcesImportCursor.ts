import {eq} from 'drizzle-orm'

import {dataSource} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

type Database = ReturnType<typeof getDatabase>

const updateDataSourceCursor = async (db: Database, id: string, cursor: string | null) => {
  const [updated] = await db
    .update(dataSource)
    .set({cursor, updatedAt: new Date()})
    .where(eq(dataSource.id, id))
    .returning({id: dataSource.id})

  if (!updated) {
    throw new Error('Data source not found')
  }
}

const createCursorUpdater = (db: Database, id: string) => {
  return async (cursor: string | null) => {
    await updateDataSourceCursor(db, id, cursor)
  }
}

export {createCursorUpdater, updateDataSourceCursor}
