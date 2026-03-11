import {eq} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {user} from '../../db/schema.ts'
import {localUserId} from '../../utils/localUser.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {ensureLocalUser} from '../utils/getLocalUser.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'

export const usersRoutes = new Elysia()
  .use(withErrorHandler())
  .get('/api/users', async () => {
    const localUser = await ensureLocalUser()
    return {data: [localUser]}
  })
  .use(
    new Elysia().patch(
      '/api/users/:id',
      async ({params, body, set}) => {
        await ensureLocalUser()
        if (localUserId !== params.id) {
          set.status = 403
          return {data: null, error: 'Only the local user row can be updated'}
        }

        const db = getDatabase()
        const [updatedUser] = await db
          .update(user)
          .set({name: body.name, updatedAt: new Date()})
          .where(eq(user.id, localUserId))
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
