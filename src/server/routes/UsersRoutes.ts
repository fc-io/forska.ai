// import {cookie} from '@elysiajs/cookie'
import {eq} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {user} from '../../../auth-schema'
import {auth} from '../../auth.ts'
import {requireAdminAuth, requireUserAuth} from '../utils/authGuard.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'

export const usersRoutes = new Elysia()
  .use(withErrorHandler())
  .use(
    new Elysia().use(requireAdminAuth()).get('/api/users', async () => {
      const db = getDatabase()
      const users = await db.select().from(user).orderBy(user.createdAt)
      return {data: users}
    }),
  )
  .use(
    new Elysia().use(requireUserAuth()).patch(
      '/api/users/:id',
      async ({params, body, set, request}) => {
        // Get session directly (consistent with other routes)
        const session = await auth.api.getSession({headers: request.headers})
        const sessionUserId = session?.user?.id ?? null

        if (!sessionUserId) {
          set.status = 401
          return {data: null, error: 'You must be signed in'}
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
    ),
  )
