import {Elysia} from 'elysia'

import {getSystemActor} from '../utils/getSystemActor.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'

export const usersRoutes = new Elysia().use(withErrorHandler()).get('/api/users', async () => {
  return {data: [getSystemActor()]}
})
