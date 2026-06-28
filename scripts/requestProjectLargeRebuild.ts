import {requestReviewServingV4Rebuild} from '../src/server/reviewServing/reviewServingV4RebuildRequestService.ts'
import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {withDuckdbMaintenanceAccess} from '../src/server/utils/duckdbScriptAccess.ts'
import {getMaintenanceDuckdbWorkloadContext} from '../src/server/utils/duckdbService.ts'

type CliOptions = {projectId: string | null; reason: string}

const defaultReason = 'requestProjectLargeRebuild'
const workloadContext = getMaintenanceDuckdbWorkloadContext('requestProjectLargeRebuild')

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
    const [project] = await getAppDatabaseService().queryJson<{id: string}>(
      `
      SELECT id
      FROM app.project
      WHERE id = '${options.projectId.replaceAll("'", "''")}'
        AND archived = FALSE
      LIMIT 1
    `,
      workloadContext,
    )

    if (!project) {
      console.log(
        JSON.stringify({
          projectId: options.projectId,
          reason: options.reason,
          requestIds: [],
          requestedCount: 0,
          status: 'not_found',
        }),
      )
      return
    }

    const request = await requestReviewServingV4Rebuild({projectId: options.projectId, reason: options.reason})
    console.log(
      JSON.stringify({
        projectId: options.projectId,
        reason: options.reason,
        requestIds: [request.requestId],
        requestedCount: 1,
        status: 'requested',
      }),
    )
  })
}

await requestProjectLargeRebuildCli()
