import {Elysia, t} from 'elysia'

import {getSystemActor} from '../utils/getSystemActor.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'

export const usersRoutes = new Elysia()
  .use(withErrorHandler())
  .get('/api/users', async () => {
    return {data: [getSystemActor()]}
  })
  .use(
    new Elysia().patch(
      '/api/users/:id',
      async ({set}) => {
        set.status = 410
        return {data: null, error: 'User profile updates were removed in no-auth mode. Set OPENALEX_MAILTO in env.'}
      },
      {body: t.Object({name: t.String(), openalexMailto: t.Optional(t.Union([t.String(), t.Null()]))})},
    ),
  )
