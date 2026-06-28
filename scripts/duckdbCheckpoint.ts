import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {withDuckdbMaintenanceAccess} from '../src/server/utils/duckdbScriptAccess.ts'
import {getMaintenanceDuckdbWorkloadContext} from '../src/server/utils/duckdbService.ts'

const workloadContext = getMaintenanceDuckdbWorkloadContext('duckdbCheckpoint')

const runDuckdbCheckpoint = async () => {
  await withDuckdbMaintenanceAccess('duckdb checkpoint', async () => {
    await getAppDatabaseService().maintenance('checkpoint', workloadContext)
    console.log('DuckDB checkpoint complete')
  })
}

if (import.meta.main) {
  await runDuckdbCheckpoint()
}
