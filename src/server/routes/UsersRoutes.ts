import {Elysia} from 'elysia'

import {user} from '../../../auth-schema'
import {getDatabase} from '../utils/getDatabase.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'

export const usersRoutes = new Elysia().use(withErrorHandler()).get('/api/users', async () => {
  const db = getDatabase()
  const users = await db.select().from(user).orderBy(user.createdAt)
  return {data: users}
})
