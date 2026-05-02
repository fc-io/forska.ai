import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {getDuckdbMartRefreshService} from '../src/server/services/getDuckdbMartRefreshService.ts'
import {withDuckdbMaintenanceAccess} from '../src/server/utils/duckdbScriptAccess.ts'

const projectScopedTables = [
  'mart.project_scope_article',
  'mart.prompt_answer_fact',
  'mart.review_article_judgment_detail',
  'app.review_answer_dictionary',
  'mart.review_article_filter_posting',
  'mart.review_article_rollup',
  'app.project_article_ordinal',
  'mart.review_article_candidate',
] as const

type ProjectScopedTable = (typeof projectScopedTables)[number]
type TableCountRow = {rowCount: number; tableName: ProjectScopedTable}

const archivedProjectCondition = 'IN (SELECT id FROM app.project WHERE archived = TRUE)'

const getArchivedProjectCount = async () => {
  const [row] = await getAppDatabaseService().queryJson<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.project
    WHERE archived = TRUE
  `)

  return Number(row?.count ?? 0)
}

const getArchivedProjectIds = async () => {
  const rows = await getAppDatabaseService().queryJson<{id: string}>(`
    SELECT DISTINCT candidate.projectId AS id
    FROM (
      ${projectScopedTables
        .map((tableName) => {
          return `SELECT project_id AS projectId FROM ${tableName}`
        })
        .join(' UNION ALL ')}
    ) candidate
    INNER JOIN app.project project ON project.id = candidate.projectId
    WHERE project.archived = TRUE
    ORDER BY id ASC
  `)

  return rows.map((row) => {
    return row.id
  })
}

const getArchivedMartRowCounts = async () => {
  return getAppDatabaseService().queryJson<TableCountRow>(
    projectScopedTables
      .map((tableName) => {
        return `SELECT '${tableName}' AS tableName, COUNT(*) AS rowCount FROM ${tableName} WHERE project_id ${archivedProjectCondition}`
      })
      .join(' UNION ALL '),
  )
}

const getPurgedRowCount = (counts: TableCountRow[]) => {
  return counts.reduce((total, row) => {
    return total + Number(row.rowCount ?? 0)
  }, 0)
}

const logCounts = (label: string, counts: TableCountRow[]) => {
  console.log(`[purgeArchivedProjectMarts] ${label}`)

  return counts
    .filter((row) => {
      return Number(row.rowCount ?? 0) > 0
    })
    .map((row) => {
      console.log(`- ${row.tableName}: ${Number(row.rowCount)}`)
      return row
    })
}

const purgeArchivedProjects = async (projectIds: string[], index = 0): Promise<void> => {
  const currentProjectId = projectIds[index]

  if (!currentProjectId) {
    return
  }

  console.log(
    `[purgeArchivedProjectMarts] purging archived project ${index + 1}/${projectIds.length}: ${currentProjectId}`,
  )
  await getDuckdbMartRefreshService().purgeArchivedProjectMartData(currentProjectId)

  return purgeArchivedProjects(projectIds, index + 1)
}

const runPurgeArchivedProjectMarts = async () => {
  await withDuckdbMaintenanceAccess('purge archived project marts', async () => {
    const archivedProjectCount = await getArchivedProjectCount()

    if (archivedProjectCount === 0) {
      console.log('[purgeArchivedProjectMarts] no archived projects found')
      return
    }

    const beforeCounts = await getArchivedMartRowCounts()
    const beforeRows = getPurgedRowCount(beforeCounts)

    logCounts('rows before purge', beforeCounts)

    if (beforeRows === 0) {
      console.log('[purgeArchivedProjectMarts] archived projects already have no mart rows')
      return
    }

    await purgeArchivedProjects(await getArchivedProjectIds())
    await getAppDatabaseService().maintenance('checkpoint')

    const afterCounts = await getArchivedMartRowCounts()
    const afterRows = getPurgedRowCount(afterCounts)

    logCounts('rows after purge', afterCounts)
    console.log(`[purgeArchivedProjectMarts] archived projects: ${archivedProjectCount}`)
    console.log(`[purgeArchivedProjectMarts] purged rows: ${beforeRows - afterRows}`)
  })
}

if (import.meta.main) {
  await runPurgeArchivedProjectMarts()
}
