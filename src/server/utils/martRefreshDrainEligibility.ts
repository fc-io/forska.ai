import {parseDuckdbMemoryLimitToMiB} from './duckdbMemoryLimit.ts'

const lowMemoryMartRefreshMaintenanceWorkerDuckdbLimitMiB = 6400

export const shouldRunMartRefreshDrainForDuckdbMemoryLimit = (duckdbMemoryLimit: string | undefined) => {
  const maintenanceWorkerDuckdbMemoryLimitMiB = parseDuckdbMemoryLimitToMiB(duckdbMemoryLimit)

  return (
    maintenanceWorkerDuckdbMemoryLimitMiB === null
    || maintenanceWorkerDuckdbMemoryLimitMiB > lowMemoryMartRefreshMaintenanceWorkerDuckdbLimitMiB
  )
}

export const shouldCurrentRuntimeRunMartRefreshDrain = () => {
  return shouldRunMartRefreshDrainForDuckdbMemoryLimit(process.env.DUCKDB_MEMORY_LIMIT)
}
