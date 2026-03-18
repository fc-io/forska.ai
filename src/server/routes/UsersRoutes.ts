import {Elysia, t} from 'elysia'

import {getUserConfigQueryService} from '../services/userConfigQueryService.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'

const getNullableString = (value: string | null): string | null => {
  const normalized = String(value ?? '').trim()

  return normalized === '' ? null : normalized
}

export const usersRoutes = new Elysia()
  .use(withErrorHandler())
  .get('/api/users', async () => {
    return {data: [await getUserConfigQueryService().getOrCreateUserConfig()]}
  })
  .patch(
    '/api/users',
    async ({body}) => {
      return {
        data: await getUserConfigQueryService().updateUserConfig({
          unpaywallEmail: getNullableString(body.unpaywallEmail),
        }),
      }
    },
    {body: t.Object({unpaywallEmail: t.Union([t.String(), t.Null()])})},
  )
