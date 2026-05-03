import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {getDuckdbMartMaintenanceService} from '../src/server/services/getDuckdbMartMaintenanceService.ts'
import {withDuckdbMaintenanceAccess} from '../src/server/utils/duckdbScriptAccess.ts'

type CliOptions = {projectId: string | null; reason: string}

const defaultReason = 'requestProjectLargeRebuild'

const getArgValue = (names: string[]) => {
  const matchedArgument = process.argv.slice(2).find((argument) => {
    return names.some((name) => {
      return argument.startsWith(`${name}=`)
    })
  })

  return matchedArgument?.slice(matchedArgument.indexOf('=') + 1).trim()
}

const getCliOptions = (): CliOptions => {
  return {
    projectId: getArgValue(['--projectId', '--project-id']) ?? null,
    reason: getArgValue(['--reason']) ?? defaultReason,
  }
}

const requestProjectLargeRebuildCli = async () => {
  const options = getCliOptions()

  if (!options.projectId) {
    console.error('Missing required --project-id=<project-id>')
    process.exitCode = 1
    return
  }

  await withDuckdbMaintenanceAccess('request project large rebuild', async () => {
    const requestedStates = await getDuckdbMartMaintenanceService().requestProjectLargeRebuild(
      options.projectId,
      options.reason,
    )

    await getAppDatabaseService().maintenance('checkpoint')
    console.log(
      JSON.stringify({
        projectId: options.projectId,
        reason: options.reason,
        requestedCount: requestedStates.length,
        status: requestedStates.length === 0 ? 'not_found' : 'requested',
      }),
    )
  })
}

await requestProjectLargeRebuildCli()
