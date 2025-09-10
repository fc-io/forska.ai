// import {eq} from 'drizzle-orm'
import {drizzle} from 'drizzle-orm/node-postgres'

import * as authSchema from '../../../auth-schema.ts'
import * as schema from '../../db/schema.ts'
import {env} from './env.ts'

const db = drizzle(env.DATABASE_URL, {
  schema: {...schema, ...authSchema},
  logger: false,
})

export const getDatabase = () => {
  return db
}
