// import {cookie} from '@elysiajs/cookie'
import {eq} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {user} from '../../../auth-schema'
import {auth} from '../../auth.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'

export const usersRoutes = new Elysia()
  .use(withErrorHandler())
  .get('/api/users', async () => {
    const db = getDatabase()
    const users = await db.select().from(user).orderBy(user.createdAt)
    return {data: users}
  })
  .patch(
    '/api/users/:id',
    async ({params, body, request, set}) => {
      const session = await auth.api.getSession({headers: request.headers})
      const sessionUserId = session?.user?.id ?? session?.session?.userId

      if (!sessionUserId) {
        set.status = 401
        return {data: null, error: 'You must be signed in to update your profile'}
      }

      if (sessionUserId !== params.id) {
        set.status = 403
        return {data: null, error: 'You are not allowed to update this user'}
      }

      const db = getDatabase()
      const [updatedUser] = await db
        .update(user)
        .set({name: body.name, updatedAt: new Date()})
        .where(eq(user.id, sessionUserId))
        .returning()

      if (!updatedUser) {
        set.status = 404
        return {data: null, error: 'User not found'}
      }

      return {data: updatedUser}
    },
    {body: t.Object({name: t.String()})},
  )
