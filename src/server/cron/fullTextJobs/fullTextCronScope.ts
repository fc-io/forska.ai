import type {FullTextConversionRuntimeConfig} from '../../fullText/converters/fullTextConverter.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getDateValue, getQuotedStringList, getSqlLiteral, getTimestampLiteral} from '../../services/appQueryHelpers.ts'
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

const getProjectDateConditions = ({dateFrom, dateTo}: Pick<FullTextCronProject, 'dateFrom' | 'dateTo'>) => {
  return [
    dateFrom ? `a.article_created_at >= ${getTimestampLiteral(getDateValue(dateFrom) ?? new Date(0))}` : null,
    dateTo ? `a.article_created_at <= ${getTimestampLiteral(getDateValue(dateTo) ?? new Date(0))}` : null,
  ].filter((part): part is string => {
    return part !== null
  })
}

export const getFullTextCronProjectArticleSql = ({
  articleConditions,
  excludedArticleIds,
  limit,
  project,
  selectColumns,
}: {
  articleConditions: string[]
  excludedArticleIds: string[]
  limit: number
  project: FullTextCronProject
  selectColumns: string
}) => {
  const projectId = getSqlLiteral(project.projectId)
  const conditions = [
    ...articleConditions,
    ...getProjectDateConditions(project),
    ...(excludedArticleIds.length > 0 ? [`a.id NOT IN (${getQuotedStringList(excludedArticleIds).join(', ')})`] : []),
  ]

  return `
    WITH project_scope_article AS (
      SELECT air.article_id
      FROM app.project_import_route pir
      INNER JOIN app.article_import_route air ON air.import_route_id = pir.import_route_id
      WHERE pir.project_id = ${projectId}
      UNION
      SELECT pa.article_id
      FROM app.project_article pa
      WHERE pa.project_id = ${projectId}
    )
    SELECT ${selectColumns}
    FROM app.article a
    INNER JOIN project_scope_article psa ON psa.article_id = a.id
    ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
    ORDER BY a.article_created_at DESC NULLS LAST, a.id ASC
    LIMIT ${limit}
  `
}

export const selectFullTextCronArticles = async <Row extends {id: string}>({
  articleConditions,
  limit,
  onProjectScanned,
  projects,
  selectColumns,
  selected = [],
  workloadContext,
}: {
  articleConditions: string[]
  limit: number
  onProjectScanned?: (input: {durationMs: number; project: FullTextCronProject; resultCount: number}) => void
  projects: FullTextCronProject[]
  selectColumns: string
  selected?: Row[]
  workloadContext: FullTextCronWorkloadContext
}): Promise<Row[]> => {
  const [project, ...remainingProjects] = projects
  const remaining = limit - selected.length

  if (!project || remaining <= 0) {
    return selected
  }

  const startedAt = Date.now()
  const rows = await getAppDatabaseService().queryJsonBackground<Row>(
    getFullTextCronProjectArticleSql({
      articleConditions,
      excludedArticleIds: selected.map((row) => {
        return row.id
      }),
      limit: remaining,
      project,
      selectColumns,
    }),
    {...workloadContext, maxResultRows: remaining, projectId: project.projectId},
  )

  onProjectScanned?.({durationMs: Date.now() - startedAt, project, resultCount: rows.length})

  return selectFullTextCronArticles({
    articleConditions,
    limit,
    onProjectScanned,
    projects: remainingProjects,
    selectColumns,
    selected: [...selected, ...rows],
    workloadContext,
  })
}
