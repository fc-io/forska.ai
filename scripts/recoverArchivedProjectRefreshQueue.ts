import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {getSqlLiteral} from '../src/server/services/appQueryHelpers.ts'
import {getDuckdbMartRefreshService} from '../src/server/services/getDuckdbMartRefreshService.ts'
import {withDuckdbMaintenanceAccess} from '../src/server/utils/duckdbScriptAccess.ts'

const archivedProjectMartTables = [
  'mart.review_article_serving_detail',
  'mart.review_article_filter_member',
  'mart.review_article_serving',
  'mart.review_article_rollup',
  'mart.review_article_filter_row',
  'mart.prompt_answer_fact',
  'mart.project_scope_article',
  'app.review_answer_dictionary',
  'app.project_review_serving_generation',
] as const

type ScriptOptions = {apply: boolean; help: boolean; projectId: string | null}
type ArchivedProjectNeedingRecoveryRow = {
  lingeringMartRowCount: number
  lingeringTableCount: number
  projectId: string
  projectName: string
}
type ArchivedProjectMartCountRow = {rowCount: number; tableName: (typeof archivedProjectMartTables)[number]}
type RecoveryReport = {
  apply: boolean
  archivedProjectsNeedingRecoveryAfter: ArchivedProjectNeedingRecoveryRow[]
  archivedProjectsNeedingRecoveryBefore: ArchivedProjectNeedingRecoveryRow[]
  completedTaskCount: number
  projectId: string | null
  projectMartRowsAfter: ArchivedProjectMartCountRow[]
  projectMartRowsBefore: ArchivedProjectMartCountRow[]
}

const getScriptOptions = (): ScriptOptions => {
  const projectIdArgument = process.argv.slice(2).find((argument) => {
    return argument.startsWith('--project-id=')
  })

  return {
    apply: process.argv.slice(2).includes('--apply'),
    help: process.argv.slice(2).includes('--help'),
    projectId: projectIdArgument?.slice('--project-id='.length) ?? null,
  }
}

const getUsageText = () => {
  return [
    'Inspect archived projects with lingering mart rows:',
    '  bun scripts/recoverArchivedProjectRefreshQueue.ts',
    '',
    'Inspect one archived project:',
    '  bun scripts/recoverArchivedProjectRefreshQueue.ts --project-id=<project-id>',
    '',
    'Repair one archived project by purging lingering mart rows:',
    '  bun scripts/recoverArchivedProjectRefreshQueue.ts --project-id=<project-id> --apply',
  ].join('\n')
}

const getArchivedProjectsNeedingRecovery = async (projectId: string | null) => {
  const projectFilter = projectId === null ? '' : `AND project.id = ${getSqlLiteral(projectId)}`
  const unionSql = archivedProjectMartTables
    .map((tableName) => {
      return `SELECT project_id AS projectId, COUNT(*) AS rowCount FROM ${tableName} GROUP BY project_id`
    })
    .join(' UNION ALL ')

  return getAppDatabaseService().queryJson<ArchivedProjectNeedingRecoveryRow>(`
    SELECT
      project.id AS projectId,
      project.name AS projectName,
      CAST(SUM(project_rows.rowCount) AS INTEGER) AS lingeringMartRowCount,
      CAST(COUNT(*) AS INTEGER) AS lingeringTableCount
    FROM (${unionSql}) project_rows
    INNER JOIN app.project project ON project.id = project_rows.projectId
    WHERE project_rows.rowCount > 0
      AND project.archived = TRUE
      ${projectFilter}
    GROUP BY project.id, project.name
    ORDER BY lingeringMartRowCount DESC, project.id ASC
  `)
}

const getArchivedProjectMartRowCounts = async (projectId: string) => {
  return getAppDatabaseService().queryJson<ArchivedProjectMartCountRow>(
    archivedProjectMartTables
      .map((tableName) => {
        return `SELECT '${tableName}' AS tableName, COUNT(*) AS rowCount FROM ${tableName} WHERE project_id = ${getSqlLiteral(projectId)}`
      })
      .join(' UNION ALL '),
  )
}

const getSelectedProjectId = (options: ScriptOptions, rows: ArchivedProjectNeedingRecoveryRow[]) => {
  if (options.projectId) {
    return options.projectId
  }

  if (rows.length === 1) {
    return rows[0]?.projectId ?? null
  }

  if (!options.apply) {
    return null
  }

  throw new Error(
    rows.length === 0
      ? 'No queued archived project refresh rows found. Nothing to recover.'
      : 'Multiple archived projects still have mart rows. Re-run with --project-id=<project-id> to recover one safely.',
  )
}

const runRecovery = async (options: ScriptOptions): Promise<RecoveryReport> => {
  const archivedProjectsNeedingRecoveryBefore = await getArchivedProjectsNeedingRecovery(options.projectId)
  const selectedProjectId = getSelectedProjectId(options, archivedProjectsNeedingRecoveryBefore)
  const projectMartRowsBefore = selectedProjectId ? await getArchivedProjectMartRowCounts(selectedProjectId) : []
  const completedTaskCount =
    !options.apply || selectedProjectId === null
      ? 0
      : (await getDuckdbMartRefreshService().recoverQueuedArchivedProjectRefresh(selectedProjectId)).completedTaskCount
  const archivedProjectsNeedingRecoveryAfter = await getArchivedProjectsNeedingRecovery(options.projectId)
  const projectMartRowsAfter = selectedProjectId ? await getArchivedProjectMartRowCounts(selectedProjectId) : []

  return {
    apply: options.apply,
    archivedProjectsNeedingRecoveryAfter,
    archivedProjectsNeedingRecoveryBefore,
    completedTaskCount,
    projectId: selectedProjectId,
    projectMartRowsAfter,
    projectMartRowsBefore,
  }
}

const runCli = async () => {
  const options = getScriptOptions()

  if (options.help) {
    console.log(getUsageText())
    return
  }

  const report = await withDuckdbMaintenanceAccess('recover archived project refresh queue', async () => {
    return runRecovery(options)
  })

  console.log(JSON.stringify(report, null, 2))
}

if (import.meta.main) {
  await runCli()
}
