import {drizzle} from 'drizzle-orm/node-postgres'
// import {integer, pgTable, text} from 'drizzle-orm/pg-core'
import {seed} from 'drizzle-seed'

import * as authSchema from '../../auth-schema.ts'
import {env} from '../server/utils/env.ts'
import * as schema from './schema.ts'

const main = async () => {
  const db = drizzle(env.DATABASE_URL)
  await seed(db, {...schema, ...authSchema})
}

void main()
