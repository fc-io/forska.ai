import {DuckDBInstance} from '@duckdb/node-api'

import type {DuckdbWorkloadContext} from './duckdbService.ts'

type EphemeralReadOnlyDuckdbFileQueryInput = {
  databasePath: string
  memoryLimit?: string
  statement: string
  workloadContext: DuckdbWorkloadContext
}

const getReadOnlyOptions = (memoryLimit: string | undefined) => {
  return {access_mode: 'READ_ONLY', memory_limit: memoryLimit ?? '6400MiB', preserve_insertion_order: 'false'}
}

export const runEphemeralReadOnlyDuckdbFileJsonQuery = async <T>({
  databasePath,
  memoryLimit,
  statement,
}: EphemeralReadOnlyDuckdbFileQueryInput): Promise<T[]> => {
  const duckdbInstance = await DuckDBInstance.create(databasePath, getReadOnlyOptions(memoryLimit))
  const connection = await duckdbInstance.connect()

  try {
    const reader = await connection.runAndReadAll(statement)

    return reader.getRowObjectsJson() as T[]
  } finally {
    connection.closeSync()
    duckdbInstance.closeSync()
  }
}
