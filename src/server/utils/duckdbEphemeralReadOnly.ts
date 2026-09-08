import {DuckDBInstance} from '@duckdb/node-api'

import {
  getDuckdbEngineOptions,
  getDuckdbLegacyWalCompatibilityError,
  isDuckdbLegacyWalCompatibilityError,
} from './duckdbEngineCompatibility.ts'
import {type DuckdbWorkloadContext, runMeasuredDuckdbJsonWorkload} from './duckdbService.ts'

type EphemeralReadOnlyDuckdbFileQueryInput = {
  databasePath: string
  memoryLimit?: string
  statement: string
  workloadContext: DuckdbWorkloadContext
}

const getReadOnlyOptions = (memoryLimit: string | undefined) => {
  return {
    ...getDuckdbEngineOptions(),
    access_mode: 'READ_ONLY',
    memory_limit: memoryLimit ?? '6400MiB',
    preserve_insertion_order: 'false',
  }
}

export const runEphemeralReadOnlyDuckdbFileJsonQuery = async <T>({
  databasePath,
  memoryLimit,
  statement,
  workloadContext,
}: EphemeralReadOnlyDuckdbFileQueryInput): Promise<T[]> => {
  const duckdbInstance = await DuckDBInstance.create(databasePath, getReadOnlyOptions(memoryLimit)).catch(
    (error: unknown) => {
      if (error instanceof Error && isDuckdbLegacyWalCompatibilityError(error.message)) {
        throw getDuckdbLegacyWalCompatibilityError(databasePath, error)
      }

      throw error
    },
  )
  const connection = await duckdbInstance.connect()

  try {
    return await runMeasuredDuckdbJsonWorkload<T>({
      operation: 'readOnlyQuery',
      queue: 'readOnly',
      queueDepthAtStart: 0,
      workloadContext,
      work: async () => {
        const reader = await connection.runAndReadAll(statement)

        return reader.getRowObjectsJson() as T[]
      },
    })
  } finally {
    connection.closeSync()
    duckdbInstance.closeSync()
  }
}
