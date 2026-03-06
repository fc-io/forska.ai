import {Elysia} from 'elysia'

import {getClickhouseHealth} from '../../services/clickhouse/clickhouseHealth.ts'
import {requireUserAuth} from '../utils/authGuard.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'

export const adminClickhouseHealthRoutes = new Elysia()
  .use(withErrorHandler())
  .use(requireUserAuth())
  .get('/api/admin/clickhouse-health', async () => {
    const data = await getClickhouseHealth()
    return {data}
  })
