import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {runArchivedProjectBoundedCleanup} from '../src/server/services/archivedProjectCleanupService.ts'
import {withDuckdbMaintenanceAccess} from '../src/server/utils/duckdbScriptAccess.ts'

type CliOptions = {batchSize: number | undefined; maxBatches: number | undefined}

const getArgValue = (names: string[]) => {
  const matchedArgument = process.argv.slice(2).find((argument) => {
    return names.some((name) => {
      return argument.startsWith(`${name}=`)
    })
  })

  return matchedArgument?.slice(matchedArgument.indexOf('=') + 1).trim()
}

const getNumberArgValue = (names: string[]) => {
  const rawValue = getArgValue(names)
  const parsed = Number(rawValue)

  return rawValue === undefined || Number.isNaN(parsed) ? undefined : parsed
}

const getCliOptions = (): CliOptions => {
  return {
    batchSize: getNumberArgValue(['--batchSize', '--batch-size']),
    maxBatches: getNumberArgValue(['--maxBatches', '--max-batches']),
  }
}

const runArchivedProjectBoundedCleanupCli = async () => {
  const result = await withDuckdbMaintenanceAccess('archived project bounded cleanup', () => {
    return runArchivedProjectBoundedCleanup(getCliOptions())
  })

  console.log(JSON.stringify(result))
}

if (import.meta.main) {
  await runArchivedProjectBoundedCleanupCli().finally(async () => {
    await getAppDatabaseService().close()
  })
}
