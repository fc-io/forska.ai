import {parseDuckdbMemoryLimitToMiB} from './duckdbMemoryLimit.ts'

const lowMemoryMartRefreshWorkerDuckdbLimitMiB = 6400

export const shouldRunMartRefreshDrainForDuckdbMemoryLimit = (duckdbMemoryLimit: string | undefined) => {
  const workerDuckdbMemoryLimitMiB = parseDuckdbMemoryLimitToMiB(duckdbMemoryLimit)

  return workerDuckdbMemoryLimitMiB === null || workerDuckdbMemoryLimitMiB > lowMemoryMartRefreshWorkerDuckdbLimitMiB
}

export const shouldCurrentRuntimeRunMartRefreshDrain = () => {
  return shouldRunMartRefreshDrainForDuckdbMemoryLimit(process.env.DUCKDB_MEMORY_LIMIT)
}
