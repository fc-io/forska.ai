import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {withDuckdbMaintenanceAccess} from '../src/server/utils/duckdbScriptAccess.ts'

const runDuckdbCheckpoint = async () => {
  await withDuckdbMaintenanceAccess('duckdb checkpoint', async () => {
    await getAppDatabaseService().maintenance('checkpoint')
    console.log('DuckDB checkpoint complete')
  })
}

if (import.meta.main) {
  await runDuckdbCheckpoint()
}
