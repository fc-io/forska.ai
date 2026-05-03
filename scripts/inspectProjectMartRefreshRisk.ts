import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'

type CliOptions = {
  incrementalArticleThreshold: number
  projectId: string
}

type RefreshStateRow = {
  dirtyToken: number | string | null
  lastCompletedDirtyToken: number | string | null
  leaseExpiresAt: string | null
  refreshStatus: string | null
  workerId: string | null
}

type CountRow = {count: number | string}

const defaultProjectMartRefreshWorkerIncrementalArticleThreshold = 3

const getProjectMartRefreshExecutionMode = ({
  dirtyArticleCount,
  incrementalArticleThreshold,
}: {
  dirtyArticleCount: number
  incrementalArticleThreshold: number
}) => {
  return dirtyArticleCount === 0 ? 'idle' : dirtyArticleCount <= incrementalArticleThreshold ? 'incremental' : 'full'
}

const getArgValue = (names: string[]) => {
  const matchedArgument = process.argv.slice(2).find((argument) => {
    return names.some((name) => {
      return argument.startsWith(`${name}=`)
    })
  })

  return matchedArgument?.slice(matchedArgument.indexOf('=') + 1)
}

const getNumberArgValue = (names: string[]) => {
  const rawValue = getArgValue(names)
  const parsed = Number(rawValue)

  return rawValue === undefined || Number.isNaN(parsed) ? undefined : parsed
}

const getCliOptions = (): CliOptions => {
  const projectId = getArgValue(['--projectId', '--project-id'])

  if (!projectId) {
    throw new Error('Missing --project-id=<project-id>')
  }

  return {
    incrementalArticleThreshold:
      getNumberArgValue(['--incrementalArticleThreshold', '--incremental-article-threshold'])
      ?? defaultProjectMartRefreshWorkerIncrementalArticleThreshold,
    projectId,
  }
}

const toNumber = (value: number | string | null | undefined) => {
  return Number(value ?? 0)
}

const getRefreshState = async (projectId: string) => {
  const [row] = await getAppDatabaseService().queryJson<RefreshStateRow>(`
    SELECT
      dirty_token AS dirtyToken,
      last_completed_dirty_token AS lastCompletedDirtyToken,
      lease_expires_at AS leaseExpiresAt,
      refresh_status AS refreshStatus,
      worker_id AS workerId
    FROM app.project_mart_refresh_state
    WHERE project_id = '${projectId}'
    LIMIT 1
  `)

  return row ?? null
}

const getCount = async (statement: string) => {
  const [row] = await getAppDatabaseService().queryJson<CountRow>(statement)

  return toNumber(row?.count)
}

const getRiskSnapshot = async ({incrementalArticleThreshold, projectId}: CliOptions) => {
  const refreshState = await getRefreshState(projectId)
  const dirtyArticleCount = await getCount(`
    SELECT COUNT(*) AS count
    FROM app.project_mart_refresh_article_state
    WHERE project_id = '${projectId}'
  `)
  const scopeArticleCount = await getCount(`
    SELECT COUNT(*) AS count
    FROM (
      SELECT article_id
      FROM app.project_article
      WHERE project_id = '${projectId}'
      UNION
      SELECT air.article_id
      FROM app.project_import_route pir
      INNER JOIN app.article_import_route air ON air.import_route_id = pir.import_route_id
      WHERE pir.project_id = '${projectId}'
    ) scope
  `)
  const hasTrackedJudgmentJobs =
    (await getCount(`SELECT COUNT(*) AS count FROM app.judgment_job WHERE project_id = '${projectId}'`)) > 0

  return {
    dirtyArticleCount,
    dirtyToken: toNumber(refreshState?.dirtyToken),
    hasTrackedJudgmentJobs,
    lastCompletedDirtyToken: toNumber(refreshState?.lastCompletedDirtyToken),
    leaseExpiresAt: refreshState?.leaseExpiresAt ?? null,
    plannedRefreshMode: getProjectMartRefreshExecutionMode({dirtyArticleCount, incrementalArticleThreshold}),
    projectId,
    refreshStatus: refreshState?.refreshStatus ?? null,
    scopeArticleCount,
    workerId: refreshState?.workerId ?? null,
  }
}

export const inspectProjectMartRefreshRisk = async () => {
  const options = getCliOptions()

  try {
    console.log(JSON.stringify(await getRiskSnapshot(options)))
  } finally {
    await getAppDatabaseService().close()
  }
}

if (import.meta.main) {
  await inspectProjectMartRefreshRisk()
}
