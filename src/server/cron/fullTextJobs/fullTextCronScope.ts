import type {FullTextConversionRuntimeConfig} from '../../fullText/converters/fullTextConverter.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getDateValue, getSqlLiteral, getTimestampLiteral} from '../../services/appQueryHelpers.ts'
import {getUserConfigQueryService} from '../../services/userConfigQueryService.ts'
import {createRateLimitedLogger} from '../../utils/rateLimitedLogger.ts'

const MAX_FULL_TEXT_PROJECTS_PER_SCAN = 100
const fullTextCronGateLogger = createRateLimitedLogger({sink: 'file-only', windowMs: 30_000})

export type FullTextCronWorkloadContext = {fallbackIntent: 'reject'; routeOrJobKey: string; workloadClass: string}

export type FullTextCronProject = {dateFrom: unknown; dateTo: unknown; hasRunningJob: boolean; projectId: string}

export type FullTextCronGateBlockedReason = 'conversion_model_missing' | 'disabled_by_env' | 'no_full_text_projects'

export type FullTextCronGate =
  | {open: true; projects: FullTextCronProject[]; runtimeConfig: FullTextConversionRuntimeConfig}
  | {open: false; reason: FullTextCronGateBlockedReason}

const fullTextCronGateBlockedMessages: Record<FullTextCronGateBlockedReason, string> = {
  conversion_model_missing: 'no PDF-to-text model is configured (Settings)',
  disabled_by_env: 'disabled by its RUN_SERVER_FULL_TEXT_* environment kill switch',
  no_full_text_projects: 'no non-archived project uses full text',
}

export const getFullTextCronProjects = async (
  workloadContext: FullTextCronWorkloadContext,
): Promise<FullTextCronProject[]> => {
  const rows = await getAppDatabaseService().queryJsonBackground<FullTextCronProject>(
    `
    SELECT
      p.id AS projectId,
      p.date_from AS dateFrom,
      p.date_to AS dateTo,
      EXISTS (
        SELECT 1
        FROM app.judgment_job jj
        WHERE jj.project_id = p.id
          AND jj.status = 'running'
      ) AS hasRunningJob
    FROM app.project p
    WHERE COALESCE(p.use_fulltext, FALSE) = TRUE
      AND COALESCE(p.archived, FALSE) = FALSE
    ORDER BY hasRunningJob DESC, p.id ASC
    LIMIT ${MAX_FULL_TEXT_PROJECTS_PER_SCAN}
  `,
    {...workloadContext, maxResultRows: MAX_FULL_TEXT_PROJECTS_PER_SCAN},
  )

  return rows.map((row) => {
    return {...row, hasRunningJob: row.hasRunningJob === true}
  })
}

export const getFullTextCronGate = async ({
  enabled,
  workloadContext,
}: {
  enabled: boolean
  workloadContext: FullTextCronWorkloadContext
}): Promise<FullTextCronGate> => {
  if (!enabled) {
    return {open: false, reason: 'disabled_by_env'}
  }

  const runtimeConfig = await getUserConfigQueryService().getFullTextConversionModelConfig()

  if (!runtimeConfig) {
    return {open: false, reason: 'conversion_model_missing'}
  }

  const projects = await getFullTextCronProjects(workloadContext)

  return projects.length === 0 ? {open: false, reason: 'no_full_text_projects'} : {open: true, projects, runtimeConfig}
}

export const logFullTextCronGateBlocked = ({
  component,
  reason,
}: {
  component: string
  reason: FullTextCronGateBlockedReason
}) => {
  fullTextCronGateLogger.log(
    `${component}:gateBlocked`,
    `[${component}] Skipped: ${fullTextCronGateBlockedMessages[reason]}`,
    {component, reason},
  )
}

const getProjectDateBoundSql = (value: unknown) => {
  return value ? getTimestampLiteral(getDateValue(value) ?? new Date(0)) : 'CAST(NULL AS TIMESTAMPTZ)'
}

const getCronProjectValuesSql = (projects: FullTextCronProject[]) => {
  return projects
    .map((project, projectRank) => {
      return `(${getSqlLiteral(project.projectId)}, ${projectRank}, ${getProjectDateBoundSql(project.dateFrom)}, ${getProjectDateBoundSql(project.dateTo)})`
    })
    .join(',\n        ')
}

const projectDateConditions = [
  '(psa.date_from IS NULL OR a.article_created_at >= psa.date_from)',
  '(psa.date_to IS NULL OR a.article_created_at <= psa.date_to)',
]

export const getFullTextCronArticleSql = ({
  articleConditions,
  limit,
  projects,
  selectColumns,
}: {
  articleConditions: string[]
  limit: number
  projects: FullTextCronProject[]
  selectColumns: string
}) => {
  return `
    WITH cron_project(project_id, project_rank, date_from, date_to) AS (
      VALUES
        ${getCronProjectValuesSql(projects)}
    ),
    project_scope_article AS (
      SELECT air.article_id, cp.project_rank, cp.date_from, cp.date_to
      FROM cron_project cp
      INNER JOIN app.project_import_route pir ON pir.project_id = cp.project_id
      INNER JOIN app.article_import_route air ON air.import_route_id = pir.import_route_id
      UNION ALL
      SELECT pa.article_id, cp.project_rank, cp.date_from, cp.date_to
      FROM cron_project cp
      INNER JOIN app.project_article pa ON pa.project_id = cp.project_id
    ),
    ranked_article AS (
      SELECT a.id, MIN(psa.project_rank) AS project_rank, ANY_VALUE(a.article_created_at) AS article_created_at
      FROM app.article a
      INNER JOIN project_scope_article psa ON psa.article_id = a.id
      WHERE ${[...articleConditions, ...projectDateConditions].join('\n        AND ')}
      GROUP BY a.id
    ),
    selected_article AS (
      SELECT id, project_rank, article_created_at
      FROM ranked_article
      ORDER BY project_rank ASC, article_created_at DESC NULLS LAST, id ASC
      LIMIT ${limit}
    )
    SELECT ${selectColumns}
    FROM selected_article selected
    INNER JOIN app.article a ON a.id = selected.id
    ORDER BY selected.project_rank ASC, selected.article_created_at DESC NULLS LAST, selected.id ASC
  `
}

export const selectFullTextCronArticles = async <Row extends {id: string}>({
  articleConditions,
  limit,
  projects,
  selectColumns,
  workloadContext,
}: {
  articleConditions: string[]
  limit: number
  projects: FullTextCronProject[]
  selectColumns: string
  workloadContext: FullTextCronWorkloadContext
}): Promise<Row[]> => {
  return projects.length === 0 || limit <= 0
    ? []
    : getAppDatabaseService().queryJsonBackground<Row>(
        getFullTextCronArticleSql({articleConditions, limit, projects, selectColumns}),
        {...workloadContext, maxResultRows: limit},
      )
}
