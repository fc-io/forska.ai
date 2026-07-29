import {
  type ReviewServingProjectionComponent,
  reviewServingProjectionComponents,
} from '../src/server/reviewServing/reviewServingContracts.ts'
import {requestReviewServingV4Rebuild} from '../src/server/reviewServing/reviewServingV4RebuildRequestService.ts'
import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {withDuckdbMaintenanceAccess} from '../src/server/utils/duckdbScriptAccess.ts'
import {getMaintenanceDuckdbWorkloadContext} from '../src/server/utils/duckdbService.ts'

type CliOptions = {
  components: readonly ReviewServingProjectionComponent[] | null
  projectId: string | null
  reason: string
}

const defaultReason = 'requestReviewServingProjectRebuild'
const workloadContext = getMaintenanceDuckdbWorkloadContext('requestReviewServingProjectRebuild')

const getArgValue = (names: string[]) => {
  const matchedArgument = process.argv.slice(2).find((argument) => {
    return names.some((name) => {
      return argument.startsWith(`${name}=`)
    })
  })

  return matchedArgument?.slice(matchedArgument.indexOf('=') + 1).trim()
}

const parseComponents = (value: string | undefined) => {
  if (value === undefined || value.trim().length === 0) {
    return null
  }

  const componentSet = new Set(reviewServingProjectionComponents)
  const components = value
    .split(',')
    .map((component) => {
      return component.trim()
    })
    .filter((component) => {
      return component.length > 0
    })

  const unknownComponents = components.filter((component) => {
    return !componentSet.has(component as ReviewServingProjectionComponent)
  })

  if (unknownComponents.length > 0) {
    throw new Error(
      `Unknown review-serving rebuild components: ${unknownComponents.join(', ')}. Known components: ${reviewServingProjectionComponents.join(', ')}`,
    )
  }

  return components as ReviewServingProjectionComponent[]
}

const getCliOptions = (): CliOptions => {
  return {
    components: parseComponents(getArgValue(['--components'])),
    projectId: getArgValue(['--projectId', '--project-id']) ?? null,
    reason: getArgValue(['--reason']) ?? defaultReason,
  }
}

const requestReviewServingProjectRebuildCli = async () => {
  const options = getCliOptions()

  if (!options.projectId) {
    console.error('Missing required --project-id=<project-id>')
    process.exitCode = 1
    return
  }

  await withDuckdbMaintenanceAccess('request review-serving project rebuild', async () => {
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

    const request = await requestReviewServingV4Rebuild({
      components: options.components ?? undefined,
      projectId: options.projectId,
      reason: options.reason,
    })
    console.log(
      JSON.stringify({
        components: options.components,
        projectId: options.projectId,
        reason: options.reason,
        requestIds: [request.requestId],
        requestedCount: 1,
        status: 'requested',
      }),
    )
  })
}

await requestReviewServingProjectRebuildCli()
