import {desc, eq} from 'drizzle-orm'
import {Elysia} from 'elysia'

import {auth} from '../../auth.ts'
import {llmStatus, vllmStatus} from '../../db/schema.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'

export const vllmStatusRoutes = new Elysia().use(withErrorHandler()).get('/api/vllmstatus', async ({request, set}) => {
  const session = await auth.api.getSession({headers: request.headers})
  const role = session?.user?.role ?? null
  if (role !== 'admin') {
    set.status = 403
    return {data: null, error: 'Administrator access required'}
  }
  const db = getDatabase()
  const primary = await db
    .select()
    .from(llmStatus)
    .where(eq(llmStatus.engine, 'vllm'))
    .orderBy(desc(llmStatus.ts))
    .limit(30)

  const data = primary.length > 0 ? primary : await db.select().from(vllmStatus).orderBy(desc(vllmStatus.ts)).limit(30)
  return {data}
})
