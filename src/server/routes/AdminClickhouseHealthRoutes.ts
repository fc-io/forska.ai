import {Elysia} from 'elysia'

import {getClickhouseHealth} from '../../services/clickhouse/clickhouseHealth.ts'
import {requireAdminAuth} from '../utils/authGuard.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'

export const adminClickhouseHealthRoutes = new Elysia()
  .use(withErrorHandler())
  .use(requireAdminAuth())
  .get('/api/admin/clickhouse-health', async () => {
    const data = await getClickhouseHealth()
    return {data}
  })

