import {desc} from 'drizzle-orm'
import {Elysia} from 'elysia'

import {auth} from '../../auth.ts'
import {nvidiaSmi} from '../../db/schema.ts'
import {requireAdminAuth} from '../utils/authGuard.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'

export const nvidiaSmiRoutes = new Elysia()
  .use(withErrorHandler())
  .use(requireAdminAuth())
  .get('/api/nvidiasmi', async ({request, set}) => {
    const session = await auth.api.getSession({headers: request.headers})
    const role = session?.user?.role ?? null
    if (role !== 'admin') {
      set.status = 403
      return {data: null, error: 'Administrator access required'}
    }

    const db = getDatabase()
    const data = await db
      .select({
        ts: nvidiaSmi.ts,
        hostname: nvidiaSmi.hostname,
        gpuIndex: nvidiaSmi.gpuIndex,
        gpuUuid: nvidiaSmi.gpuUuid,
        gpuName: nvidiaSmi.gpuName,
        temperatureGpu: nvidiaSmi.temperatureGpu,
        utilizationGpu: nvidiaSmi.utilizationGpu,
        utilizationMemory: nvidiaSmi.utilizationMemory,
        memoryTotalMiB: nvidiaSmi.memoryTotalMiB,
        memoryUsedMiB: nvidiaSmi.memoryUsedMiB,
        powerDrawWatts: nvidiaSmi.powerDrawWatts,
        powerLimitWatts: nvidiaSmi.powerLimitWatts,
        fanSpeed: nvidiaSmi.fanSpeed,
        pstate: nvidiaSmi.pstate,
      })
      .from(nvidiaSmi)
      .orderBy(desc(nvidiaSmi.ts))
      .limit(30)

    return {data}
  })
