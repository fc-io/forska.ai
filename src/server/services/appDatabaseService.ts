import {
  closeDuckdbService,
  getDuckdbRuntimeConfig,
  runDuckdbJsonQuery,
  runDuckdbMaintenance,
  runDuckdbStatement,
  runDuckdbTransaction,
} from '../utils/duckdbService.ts'

type AppDatabaseMaintenanceCommand = 'checkpoint' | 'force_checkpoint'

const appDatabaseService = {
  close: closeDuckdbService,
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
