// import {eq} from 'drizzle-orm'
import {drizzle} from 'drizzle-orm/node-postgres'

import * as authSchema from '../../../auth-schema.ts'
import {testElysiaTable} from '../../db/schema.ts'
import {env} from './env.ts'

const db = drizzle(env.DATABASE_URL, {
  schema: {testElysiaTable, ...authSchema},
  logger: true,
})

export const getDatabase = () => {
  return db
}
