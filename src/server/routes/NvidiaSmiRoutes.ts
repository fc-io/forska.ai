import {desc} from 'drizzle-orm'
import {Elysia} from 'elysia'

import {nvidiaSmi} from '../../db/schema.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {hasSqliteTable} from '../utils/hasSqliteTable.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'

export const nvidiaSmiRoutes = new Elysia().use(withErrorHandler()).get('/api/nvidiasmi', async () => {
  if (!hasSqliteTable('nvidia_smi')) {
    return {data: []}
  }

  const db = getDatabase()
  const data = await db
    .select({
      ts: nvidiaSmi.ts,
      instanceId: nvidiaSmi.instanceId,
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
