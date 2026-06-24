import {requestReviewServingV4Rebuild} from '../src/server/reviewServing/reviewServingV4RebuildRequestService.ts'
import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {withDuckdbMaintenanceAccess} from '../src/server/utils/duckdbScriptAccess.ts'

type RequestReviewServingLargeRebuildOptions = {includeArchived: boolean; projectId: string | null}
type RequestReviewServingLargeRebuildFailure = {error: string; projectId: string}
type RequestReviewServingLargeRebuildResult = {
  failedProjects: RequestReviewServingLargeRebuildFailure[]
  requestIds: string[]
}

const getRequestOptions = (): RequestReviewServingLargeRebuildOptions => {
  const projectIdArg = process.argv.slice(2).find((argument) => {
    return argument.startsWith('--project-id=')
  })

  return {
    includeArchived: process.argv.slice(2).includes('--include-archived'),
    projectId: projectIdArg?.split('=')[1] ?? null,
  }
}

const quoteSqlString = (value: string) => {
  return `'${value.replaceAll("'", "''")}'`
}

const getProjectIds = async (options: RequestReviewServingLargeRebuildOptions) => {
  const whereClause = options.projectId
    ? `WHERE id = ${quoteSqlString(options.projectId)}${options.includeArchived ? '' : ' AND archived = FALSE'}`
    : options.includeArchived
      ? ''
      : 'WHERE archived = FALSE'
  const rows = await getAppDatabaseService().queryJson<{id: string}>(`
    SELECT id
    FROM app.project
    ${whereClause}
    ORDER BY id ASC
  `)

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

const getRequestStatus = (result: RequestReviewServingLargeRebuildResult) => {
  return result.failedProjects.length === 0
    ? 'requested'
    : result.requestIds.length === 0
      ? 'failed'
      : 'requested_with_failures'
}

const requestProjectLargeRebuilds = async (
  projectIds: string[],
  index = 0,
): Promise<RequestReviewServingLargeRebuildResult> => {
  const currentProjectId = projectIds[index]

  if (!currentProjectId) {
    return {failedProjects: [], requestIds: []}
  }

  console.log(`[requestReviewServingLargeRebuild] requesting ${index + 1}/${projectIds.length} ${currentProjectId}`)
  try {
    const request = await requestReviewServingV4Rebuild({
      projectId: currentProjectId,
      reason: 'requestReviewServingLargeRebuild',
    })
    const remaining = await requestProjectLargeRebuilds(projectIds, index + 1)

    return {failedProjects: remaining.failedProjects, requestIds: [request.requestId, ...remaining.requestIds]}
  } catch (error) {
    const failure = {error: getFailureMessage(error), projectId: currentProjectId}
    console.error(`[requestReviewServingLargeRebuild] failed ${currentProjectId}: ${failure.error}`)
    const remaining = await requestProjectLargeRebuilds(projectIds, index + 1)

    return {failedProjects: [failure, ...remaining.failedProjects], requestIds: remaining.requestIds}
  }
}

const main = async () => {
  const options = getRequestOptions()

  await withDuckdbMaintenanceAccess('request review serving large rebuild', async () => {
    const projectIds = await getProjectIds(options)

    if (projectIds.length === 0) {
      console.log('[requestReviewServingLargeRebuild] no matching projects')
      console.log(JSON.stringify({projectCount: 0, requestedCount: 0, status: 'not_found'}))
      return
    }

    const result = await requestProjectLargeRebuilds(projectIds)
    console.log(
      JSON.stringify({
        failedCount: result.failedProjects.length,
        failedProjects: result.failedProjects,
        projectCount: projectIds.length,
        requestIds: result.requestIds,
        requestedCount: result.requestIds.length,
        status: getRequestStatus(result),
      }),
    )
  })
}

await main()
