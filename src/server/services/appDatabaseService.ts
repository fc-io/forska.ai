import {
  closeDuckdbService,
  createDuckdbSnapshot,
  deleteDuckdbSnapshot,
  type DuckdbSnapshot,
  getDuckdbRuntimeConfig,
  runDuckdbJsonQuery,
  runDuckdbMaintenance,
  runDuckdbStatement,
  runDuckdbTransaction,
} from '../utils/duckdbService.ts'
import {clearWriterWriteFailure, recordWriterWriteFailure} from '../utils/writerWarnings.ts'

type AppDatabaseMaintenanceCommand = 'checkpoint' | 'force_checkpoint'
type AppDatabaseSnapshot = DuckdbSnapshot

const withWriterWriteTracking = async <_T>(action: string, operation: () => Promise<_T>): Promise<_T> => {
  try {
    const result = await operation()
    clearWriterWriteFailure()
    return result
  } catch (error) {
    recordWriterWriteFailure({action, error})
    throw error
  }
}

const appDatabaseService = {
  close: closeDuckdbService,
  createSnapshot: async () => {
    return withWriterWriteTracking('createSnapshot', createDuckdbSnapshot)
  },
  deleteSnapshot: deleteDuckdbSnapshot,
  getRuntimeConfig: getDuckdbRuntimeConfig,
  maintenance: async (command: AppDatabaseMaintenanceCommand) => {
    await withWriterWriteTracking(`maintenance:${command}`, () => {
      return runDuckdbMaintenance(command)
    })
  },
  queryJson: runDuckdbJsonQuery,
  run: async (statement: string) => {
    await withWriterWriteTracking('run', () => {
      return runDuckdbStatement(statement)
    })
  },
  transaction: async (operation: Parameters<typeof runDuckdbTransaction>[0]) => {
    return withWriterWriteTracking('transaction', () => {
      return runDuckdbTransaction(operation)
    })
  },
}

export const getAppDatabaseService = () => {
  return appDatabaseService
}

export type {AppDatabaseSnapshot}
