import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {getDuckdbMartMaintenanceService} from '../src/server/services/getDuckdbMartMaintenanceService.ts'
import {withDuckdbMaintenanceAccess} from '../src/server/utils/duckdbScriptAccess.ts'

type CliOptions = {allActiveProjects: boolean; projectId: string | null; reason: string}

type DuplicateJudgmentFactRow = {judgmentId: string; rowCount: number | string}

const defaultReason = 'requestJudgmentFactRepair'

const quoteSqlString = (value: string) => {
  return `'${value.replaceAll("'", "''")}'`
}

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
    allActiveProjects: process.argv.slice(2).includes('--all-active-projects'),
    projectId: getArgValue(['--projectId', '--project-id']) ?? null,
    reason: getArgValue(['--reason']) ?? defaultReason,
  }
}

const getDuplicateJudgmentFacts = async () => {
  return getAppDatabaseService().queryJson<DuplicateJudgmentFactRow>(`
    SELECT judgment_id AS judgmentId, COUNT(*) AS rowCount
    FROM mart.judgment_fact
    GROUP BY judgment_id
    HAVING COUNT(*) > 1
    ORDER BY rowCount DESC, judgmentId ASC
  `)
}

const getActiveProjectIds = async () => {
  const rows = await getAppDatabaseService().queryJson<{projectId: string}>(`
    SELECT id AS projectId
    FROM app.project
    WHERE archived = FALSE
    ORDER BY id ASC
  `)

  return rows.map((row) => {
    return row.projectId
  })
}

const getExplicitProjectIds = async (projectId: string) => {
  const rows = await getAppDatabaseService().queryJson<{projectId: string}>(`
    SELECT id AS projectId
    FROM app.project
    WHERE id = ${quoteSqlString(projectId)}
      AND archived = FALSE
  `)

  return rows.map((row) => {
    return row.projectId
  })
}

const getDuplicateImpactedProjectIds = async () => {
  const rows = await getAppDatabaseService().queryJson<{projectId: string}>(`
    WITH duplicate_judgment AS (
      SELECT judgment_id
      FROM mart.judgment_fact
      GROUP BY judgment_id
      HAVING COUNT(*) > 1
    )
    SELECT DISTINCT COALESCE(fact.project_id, fact.snapshot_project_id) AS projectId
    FROM mart.judgment_fact fact
    INNER JOIN duplicate_judgment duplicate
      ON duplicate.judgment_id = fact.judgment_id
    INNER JOIN app.project project
      ON project.id = COALESCE(fact.project_id, fact.snapshot_project_id)
    WHERE project.archived = FALSE
      AND COALESCE(fact.project_id, fact.snapshot_project_id) IS NOT NULL
    ORDER BY projectId ASC
  `)

  return rows.map((row) => {
    return row.projectId
  })
}

const getRepairProjectIds = async (options: CliOptions) => {
  return options.projectId
    ? getExplicitProjectIds(options.projectId)
    : options.allActiveProjects
      ? getActiveProjectIds()
      : getDuplicateImpactedProjectIds()
}

const getDuplicateSummary = (rows: DuplicateJudgmentFactRow[]) => {
  return rows.slice(0, 20).map((row) => {
    return {judgmentId: row.judgmentId, rowCount: Number(row.rowCount)}
  })
}

const main = async () => {
  const options = getCliOptions()

  await withDuckdbMaintenanceAccess('request judgment fact repair', async () => {
    const [duplicateJudgmentFacts, projectIds] = await Promise.all([
      getDuplicateJudgmentFacts(),
      getRepairProjectIds(options),
    ])

    if (projectIds.length === 0) {
      console.log(
        JSON.stringify({
          duplicateJudgmentFacts: getDuplicateSummary(duplicateJudgmentFacts),
          projectIds,
          reason: options.reason,
          requestedCount: 0,
          status: 'not_found',
        }),
      )
      return
    }

    const requestedStates = await getDuckdbMartMaintenanceService().requestProjectLargeRebuilds(
      projectIds,
      options.reason,
    )

    await getAppDatabaseService().maintenance('checkpoint')
    console.log(
      JSON.stringify({
        duplicateJudgmentFacts: getDuplicateSummary(duplicateJudgmentFacts),
        projectIds,
        reason: options.reason,
        requestedCount: requestedStates.length,
        status: 'requested',
      }),
    )
  })
}

await main()
