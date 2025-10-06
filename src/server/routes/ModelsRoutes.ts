import {asc} from 'drizzle-orm'
import {Elysia} from 'elysia'

import {models} from '../../db/schema.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'

export const modelsRoutes = new Elysia()
  .use(withErrorHandler())
  .get('/api/models', async () => {
    const db = getDatabase()
    const list = await db.select().from(models).orderBy(asc(models.createdAt))
    return {data: list}
  })

