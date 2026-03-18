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

type AppDatabaseMaintenanceCommand = 'checkpoint' | 'force_checkpoint'
type AppDatabaseSnapshot = DuckdbSnapshot

const appDatabaseService = {
  close: closeDuckdbService,
  createSnapshot: createDuckdbSnapshot,
  deleteSnapshot: deleteDuckdbSnapshot,
  getRuntimeConfig: getDuckdbRuntimeConfig,
  maintenance: async (command: AppDatabaseMaintenanceCommand) => {
    await runDuckdbMaintenance(command)
  },
  queryJson: runDuckdbJsonQuery,
  run: runDuckdbStatement,
  transaction: runDuckdbTransaction,
}

export const getAppDatabaseService = () => {
  return appDatabaseService
}

export type {AppDatabaseSnapshot}
