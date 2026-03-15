import {Elysia} from 'elysia'

import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'

export const nvidiaSmiRoutes = new Elysia().use(withErrorHandler()).get('/api/nvidiasmi', async () => {
  const [tableRow] = await getAppDatabaseService().queryJson<{tableName: string}>(`
    SELECT table_name AS tableName
    FROM information_schema.tables
    WHERE table_schema = 'app'
      AND table_name = 'nvidia_smi'
    LIMIT 1
  `)

  if (!tableRow) {
    return {data: []}
  }

  const data = await getAppDatabaseService().queryJson<{
    ts: string
    instanceId: string
    gpuIndex: number
    gpuUuid: string | null
    gpuName: string | null
    temperatureGpu: number | null
    utilizationGpu: number | null
    utilizationMemory: number | null
    memoryTotalMiB: number | null
    memoryUsedMiB: number | null
    powerDrawWatts: number | null
    powerLimitWatts: number | null
    fanSpeed: number | null
    pstate: string | null
  }>(`
    SELECT
      ts,
      instance_id AS instanceId,
      gpu_index AS gpuIndex,
      gpu_uuid AS gpuUuid,
      gpu_name AS gpuName,
      temperature_gpu AS temperatureGpu,
      utilization_gpu AS utilizationGpu,
      utilization_memory AS utilizationMemory,
      memory_total_mib AS memoryTotalMiB,
      memory_used_mib AS memoryUsedMiB,
      power_draw_watts AS powerDrawWatts,
      power_limit_watts AS powerLimitWatts,
      fan_speed AS fanSpeed,
      pstate
    FROM app.nvidia_smi
    ORDER BY ts DESC
    LIMIT 30
  `)

  return {data}
})
