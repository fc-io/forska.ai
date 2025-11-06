import {desc, eq} from 'drizzle-orm'
import {Elysia} from 'elysia'

import {auth} from '../../auth.ts'
import {llmStatus} from '../../db/schema.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'

export const llmStatusRoutes = new Elysia()
  .use(withErrorHandler())
  .get('/api/llmstatus', async ({request, set}) => {
    const session = await auth.api.getSession({headers: request.headers})
    const role = session?.user?.role ?? null
    if (role !== 'admin') {
      set.status = 403
      return {data: null, error: 'Administrator access required'}
    }

    const db = getDatabase()
    const data = await db
      .select()
      .from(llmStatus)
      .where(eq(llmStatus.engine, 'sglang'))
      .orderBy(desc(llmStatus.ts))
      .limit(30)

    return {data}
  })

