import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {getDuckdbMartRefreshService} from '../src/server/services/getDuckdbMartRefreshService.ts'
import {withDuckdbMaintenanceAccess} from '../src/server/utils/duckdbScriptAccess.ts'

type BackfillOptions = {includeArchived: boolean; projectId: string | null}

const getBackfillOptions = (): BackfillOptions => {
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

const getProjectIds = async (options: BackfillOptions) => {
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

const backfillProjects = async (projectIds: string[], index = 0): Promise<void> => {
  const currentProjectId = projectIds[index]

  if (!currentProjectId) {
    return
  }

  console.log(`[backfillReviewServingV3] queueing large rebuild ${index + 1}/${projectIds.length} ${currentProjectId}`)
  await getDuckdbMartRefreshService().queueProjectLargeRebuild(currentProjectId, 'backfillReviewServingV3')
  return backfillProjects(projectIds, index + 1)
}

const main = async () => {
  const options = getBackfillOptions()

  await withDuckdbMaintenanceAccess('backfill review serving v3', async () => {
    const projectIds = await getProjectIds(options)

    if (projectIds.length === 0) {
      console.log('[backfillReviewServingV3] no matching projects')
      return
    }

    await backfillProjects(projectIds)
    await getAppDatabaseService().maintenance('checkpoint')
  })
}

await main()
