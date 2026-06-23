import {requestReviewServingV4Rebuild} from '../src/server/reviewServing/reviewServingV4RebuildRequestService.ts'
import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {withDuckdbMaintenanceAccess} from '../src/server/utils/duckdbScriptAccess.ts'

type RequestReviewServingLargeRebuildOptions = {includeArchived: boolean; projectId: string | null}

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

const requestProjectLargeRebuilds = async (projectIds: string[], index = 0): Promise<string[]> => {
  const currentProjectId = projectIds[index]

  if (!currentProjectId) {
    return []
  }

  console.log(`[requestReviewServingLargeRebuild] requesting ${index + 1}/${projectIds.length} ${currentProjectId}`)
  const request = await requestReviewServingV4Rebuild({
    projectId: currentProjectId,
    reason: 'requestReviewServingLargeRebuild',
  })
  const remainingRequestIds = await requestProjectLargeRebuilds(projectIds, index + 1)

  return [request.requestId, ...remainingRequestIds]
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

    const requestIds = await requestProjectLargeRebuilds(projectIds)
    console.log(
      JSON.stringify({
        projectCount: projectIds.length,
        requestIds,
        requestedCount: requestIds.length,
        status: 'requested',
      }),
    )
  })
}

await main()
