import {writeFileSync} from 'node:fs'

import {requestReviewServingV4Rebuild} from '../src/server/reviewServing/reviewServingV4RebuildRequestService.ts'
import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {withDuckdbMaintenanceAccess} from '../src/server/utils/duckdbScriptAccess.ts'
import {getMaintenanceDuckdbWorkloadContext} from '../src/server/utils/duckdbService.ts'

type RequestReviewServingAllProjectsRebuildOptions = {
  includeArchived: boolean
  jsonOutputFile: string | null
  projectId: string | null
}
type RequestReviewServingAllProjectsRebuildFailure = {error: string; projectId: string}
type RequestReviewServingAllProjectsRebuildResult = {
  failedProjects: RequestReviewServingAllProjectsRebuildFailure[]
  requestIds: string[]
}
const workloadContext = getMaintenanceDuckdbWorkloadContext('requestReviewServingAllProjectsRebuild')

const writeJson = (value: unknown, options: Pick<RequestReviewServingAllProjectsRebuildOptions, 'jsonOutputFile'>) => {
  const output = `${JSON.stringify(value)}\n`

  process.stdout.write(output)

  if (options.jsonOutputFile !== null) {
    writeFileSync(options.jsonOutputFile, output, 'utf8')
  }
}

const getArgValue = (name: string) => {
  const argument = process.argv.slice(2).find((item) => {
    return item.startsWith(`${name}=`)
  })

  return argument?.split('=')[1] ?? null
}

const getRequestOptions = (): RequestReviewServingAllProjectsRebuildOptions => {
  return {
    includeArchived: process.argv.slice(2).includes('--include-archived'),
    jsonOutputFile: getArgValue('--json-output-file') ?? getArgValue('--output-json'),
    projectId: getArgValue('--project-id'),
  }
}

const quoteSqlString = (value: string) => {
  return `'${value.replaceAll("'", "''")}'`
}

const getProjectIds = async (options: RequestReviewServingAllProjectsRebuildOptions) => {
  const whereClause = options.projectId
    ? `WHERE id = ${quoteSqlString(options.projectId)}${options.includeArchived ? '' : ' AND archived = FALSE'}`
    : options.includeArchived
      ? ''
      : 'WHERE archived = FALSE'
  const rows = await getAppDatabaseService().queryJson<{id: string}>(
    `
    SELECT id
    FROM app.project
    ${whereClause}
    ORDER BY id ASC
  `,
    workloadContext,
  )

  return rows.map((row) => {
    return row.id
  })
}

const getFailureMessage = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  const details = String(error)
  const rebuildChunkMessage = details.match(/Review rebuild request [^\n]+ created no rebuild chunks/u)?.[0]

  return rebuildChunkMessage ?? message
}

const getRequestStatus = (result: RequestReviewServingAllProjectsRebuildResult) => {
  return result.failedProjects.length === 0
    ? 'requested'
    : result.requestIds.length === 0
      ? 'failed'
      : 'requested_with_failures'
}

const requestReviewServingProjectRebuilds = async (
  projectIds: string[],
  index = 0,
): Promise<RequestReviewServingAllProjectsRebuildResult> => {
  const currentProjectId = projectIds[index]

  if (!currentProjectId) {
    return {failedProjects: [], requestIds: []}
  }

  console.log(
    `[requestReviewServingAllProjectsRebuild] requesting ${index + 1}/${projectIds.length} ${currentProjectId}`,
  )
  try {
    const request = await requestReviewServingV4Rebuild({
      projectId: currentProjectId,
      reason: 'requestReviewServingAllProjectsRebuild',
    })
    const remaining = await requestReviewServingProjectRebuilds(projectIds, index + 1)

    return {failedProjects: remaining.failedProjects, requestIds: [request.requestId, ...remaining.requestIds]}
  } catch (error) {
    const failure = {error: getFailureMessage(error), projectId: currentProjectId}
    console.error(`[requestReviewServingAllProjectsRebuild] failed ${currentProjectId}: ${failure.error}`)
    const remaining = await requestReviewServingProjectRebuilds(projectIds, index + 1)

    return {failedProjects: [failure, ...remaining.failedProjects], requestIds: remaining.requestIds}
  }
}

const main = async () => {
  const options = getRequestOptions()

  await withDuckdbMaintenanceAccess('request review serving all projects rebuild', async () => {
    const projectIds = await getProjectIds(options)

    if (projectIds.length === 0) {
      console.log('[requestReviewServingAllProjectsRebuild] no matching projects')
      writeJson({projectCount: 0, requestedCount: 0, status: 'not_found'}, options)
      return
    }

    const result = await requestReviewServingProjectRebuilds(projectIds)
    writeJson(
      {
        failedCount: result.failedProjects.length,
        failedProjects: result.failedProjects,
        projectCount: projectIds.length,
        requestIds: result.requestIds,
        requestedCount: result.requestIds.length,
        status: getRequestStatus(result),
      },
      options,
    )
  })
}

await main()
