import {Elysia, t} from 'elysia'

import type {
  ComparisonProjectRecord,
  ComparisonProjectServingStatus,
  HumanJudgmentMode,
  ProjectPromptCriteriaDisposition,
} from '../../db/schemaTypes.ts'
import {getOrderedComparisonProjectColumns} from '../../utils/comparisonProjectColumnOrder.ts'
import {
  type ComparisonProjectDifferenceColumn,
  type ComparisonProjectDifferenceFilter,
  getNormalizedComparisonProjectDifferenceFilter,
} from '../../utils/comparisonProjectDifferenceFilter.ts'
import {
  type ComparisonProjectRowFilter,
  getNormalizedComparisonProjectRowFilter,
} from '../../utils/comparisonProjectRowFilter.ts'
import {
  appendProviderModelThinkingBadgeLabel,
  getProviderModelThinkingBadgeValue,
} from '../../utils/providerModelLabel.ts'
import {getProviderModelMetadataOptions} from '../providers/providerModelMetadata.ts'
import {assertSelectableProviderModelIds} from '../providers/providerModelRepository.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import * as appQueryHelpers from '../services/appQueryHelpers.ts'
import {
  type ComparisonProjectServingProgress,
  type ComparisonProjectServingStatusRow,
  getComparisonProjectServingRebuildService,
} from '../services/comparisonProjectServingRebuildService.ts'
import {HttpError} from '../utils/httpError.ts'
import {
  deriveStrictSummaryAnswer,
  getNormalizedSummaryAnswer,
  hasAnyJudgmentAnswer,
  normalizeSummaryAnswerValue,
} from '../utils/judgmentAnswers.ts'
import {withErrorHandler} from '../utils/routeErrorHandler.ts'
import {
  type ComparisonProjectConflictResolutionImportSourceQueryRow,
  getComparisonProjectConflictResolutionImportSourcesSql,
  getComparisonProjectConflictResolutionImportSourceValue,
} from './comparisonProjectsRoutes/comparisonProjectConflictResolutionImport.ts'
import {
  type ComparisonProjectJudgmentHumanRow,
  type ComparisonProjectJudgmentLlmRow,
  type ComparisonProjectJudgmentRow,
  forEachComparisonProjectServingJudgmentRowBatch,
  getComparisonProjectBatchRows,
  getComparisonProjectColumnId,
  getComparisonProjectContentKey,
  getComparisonProjectRequiredColumnIds,
  getComparisonProjectScopedArticleBatch,
  getComparisonProjectServingJudgmentCount,
  getComparisonProjectServingJudgmentRowsPage,
} from './comparisonProjectsRoutes/comparisonProjectJudgmentRows.ts'
import {
  type ComparisonProjectAdditionalStats,
  type ComparisonProjectStatsComparison,
  getComparisonProjectAdditionalStats,
  getComparisonProjectStats,
} from './comparisonProjectsRoutes/comparisonProjectStats.ts'

type PromptSelection = {
  promptId: string
  order: number
  criteriaDisposition?: ProjectPromptCriteriaDisposition | null
  criteriaSectionKey?: string | null
  criteriaSectionLabel?: string | null
}
type AppDatabaseService = ReturnType<typeof getAppDatabaseService>
type AppTx = Parameters<AppDatabaseService['transaction']>[0] extends (runner: infer T) => Promise<unknown> ? T : never
type AppQueryRunner = Pick<AppTx, 'queryJson'>
type ComparisonProjectContentVariant = {
  key: string
  label: string
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
}
type ComparisonProjectPromptConfig = {
  id: string
  promptHeading: string | null
  promptLabel: string
  type: string | null
  order: number
  criteriaDisposition: ProjectPromptCriteriaDisposition | null
  criteriaSectionKey: string | null
  criteriaSectionLabel: string | null
}
type ComparisonProjectModelConfig = {
  id: string
  metadataJson: unknown
  name: string
  provider?: string | null
  version?: string | null
}
type ComparisonProjectJudgmentsColumn = ComparisonProjectDifferenceColumn & {
  promptLabel: string
  modelId: string | null
  modelLabel: string
  contentLabel: string | null
  sourceProjectId: string | null
  sourceProjectName: string | null
}
type ComparisonProjectSourceSummaryPromptConfig = ComparisonProjectPromptConfig & {sourceProjectId: string}
type ComparisonProjectSummaryPromptGroup = {
  modelId: string | null
  prompts: ComparisonProjectPromptConfig[]
  sourceProjectId: string | null
}
type ComparisonProjectScope = {
  id: string
  name: string
  description: string | null
  activeGeneration: number | null
  compareWithHumans: boolean
  allowConflictResolution: boolean
  humanJudgmentMode: HumanJudgmentMode
  isServingReady: boolean
  servingStatus: ComparisonProjectServingStatus
  servingProgress: ComparisonProjectServingProgress
  servingUpdatedAt: Date | null
  summarySourceProjectId: string | null
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  archived: boolean
  createdAt: Date
  modelIds: string[] | null
  sourceProjectIds: string[]
  useImportRoutesForScope: boolean
  summarySourceProject: ComparisonProjectSummarySourceProject | null
  sourceProjects: ComparisonProjectLinkedSourceProject[]
  contentVariants: ComparisonProjectContentVariant[]
  prompts: ComparisonProjectPromptConfig[]
  sourceProjectSummaryPrompts: ComparisonProjectSourceSummaryPromptConfig[]
  models: ComparisonProjectModelConfig[]
  importRouteIds: string[]
  columns: ComparisonProjectJudgmentsColumn[]
}
type ComparisonProjectStatsResponse = {
  activeGeneration: number | null
  additionalProjectStats: ComparisonProjectAdditionalStats
  comparisons: ComparisonProjectStatsComparison[]
  isServingReady: boolean
  servingStatus: ComparisonProjectServingStatus
  servingUpdatedAt: Date | null
}
type ComparisonProjectLlmRow = ComparisonProjectJudgmentLlmRow
type ComparisonProjectHumanRow = ComparisonProjectJudgmentHumanRow
type ComparisonProjectConflictResolution = {articleId: string; label: string; value: string}
type ComparisonProjectExportRow = ComparisonProjectJudgmentRow & {
  conflictResolution?: ComparisonProjectConflictResolution | null
}
type ComparisonProjectConflictResolutionOption = {label: string; value: string}
type ComparisonProjectSourcePrompt = {
  id: string
  promptHeading: string | null
  order: number
  criteriaDisposition: ProjectPromptCriteriaDisposition | null
  criteriaSectionKey: string | null
  criteriaSectionLabel: string | null
}
type ComparisonProjectSourceImportRoute = {route: string; name: string | null}
type ComparisonProjectSource = {
  id: string
  name: string
  description: string | null
  modelId: string
  modelMetadataJson?: unknown
  modelProvider?: string | null
  modelVersion?: string | null
  modelName: string
  humanJudgmentMode: HumanJudgmentMode
  isSummaryCapable: boolean
  summarySourceProjectId: string | null
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  prompts: ComparisonProjectSourcePrompt[]
  importRoutes: ComparisonProjectSourceImportRoute[]
}
type ComparisonProjectSummarySourceProject = {
  id: string
  name: string
  description: string | null
  modelId: string
  modelName: string
  humanJudgmentMode: HumanJudgmentMode
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
}
type ComparisonProjectLinkedSourceProject = {
  id: string
  name: string
  description: string | null
  modelId: string
  modelName: string
  humanJudgmentMode: HumanJudgmentMode
}
type ComparisonProjectEditPrompt = {
  id: string
  originalText: string
  promptHeading: string | null
  type: string | null
  createdAt: Date
  archived: boolean
}
type ComparisonProjectRecordRow = Omit<ComparisonProjectRecord, 'createdAt' | 'modelIds' | 'updatedAt'> & {
  createdAt: unknown
  modelIds: unknown
  updatedAt: unknown
}

const hasSummaryPromptCriteriaMetadata = (prompt: {
  criteriaDisposition: ProjectPromptCriteriaDisposition | null
  criteriaSectionKey: string | null
}) => {
  return Boolean(prompt.criteriaDisposition && prompt.criteriaSectionKey)
}

const getSourceProjectSummaryPromptSelections = (sourceProject: ComparisonProjectSource) => {
  return [...sourceProject.prompts]
    .filter(hasSummaryPromptCriteriaMetadata)
    .sort((left, right) => {
      return left.order - right.order
    })
    .map<PromptSelection>((prompt) => {
      return {
        promptId: prompt.id,
        order: prompt.order,
        criteriaDisposition: prompt.criteriaDisposition,
        criteriaSectionKey: prompt.criteriaSectionKey,
        criteriaSectionLabel: prompt.criteriaSectionLabel,
      }
    })
}

const comparisonProjectTable = 'app.comparison_project'
const comparisonProjectPromptTable = 'app.comparison_project_prompt'
const comparisonProjectImportRouteTable = 'app.comparison_project_import_route'
const comparisonProjectSourceProjectTable = 'app.comparison_project_source_project'
const comparisonProjectConflictResolutionTable = 'app.comparison_project_conflict_resolution'
const promptTable = 'app.prompt'
const importRouteTable = 'app.import_route'
const projectTable = 'app.project'
const projectPromptTable = 'app.project_prompt'
const projectImportRouteTable = 'app.project_import_route'
const projectArticleTable = 'app.project_article'
const modelTable = 'app.model'
const articleTable = 'app.article'
const articleImportRouteTable = 'app.article_import_route'
const judgmentTable = 'app.judgment'
const judgmentHumanTable = 'app.judgment_human'
const judgmentHumanSummaryTable = 'app.judgment_human_summary'
const appDatabaseService = getAppDatabaseService()
const comparisonProjectServingRebuildService = getComparisonProjectServingRebuildService()
const {getDateValue, getJsonValue, getQuotedStringList, getSqlLiteral} = appQueryHelpers
const summaryPromptId = 'summary'
const summaryPromptLabel = 'Overall decision'
const comparisonProjectJudgmentArticleBatchSize = 20000
const comparisonProjectRoutesLoadedAt = new Date()

const getRequestedPositiveInteger = (value: string | number | null | undefined, fallback: number) => {
  const parsedValue = Number.parseInt(String(value ?? ''), 10)

  return Number.isNaN(parsedValue) ? fallback : parsedValue
}

const getComparisonProjectJudgmentsCursor = (params: {cursor?: string | null; limit: number; page: number}) => {
  return params.cursor ?? (params.page > 1 ? String((params.page - 1) * params.limit - 1) : null)
}

const getRequiredDateValue = (value: unknown) => {
  const parsedDate = getDateValue(value)
  return parsedDate ?? new Date(0)
}

const getComparisonProjectServingUpdatedAt = (status: ComparisonProjectServingStatusRow) => {
  return (
    status.generationUpdatedAt ?? status.servingCompletedAt ?? status.servingFailedAt ?? status.servingStartedAt ?? null
  )
}

const getComparisonProjectServingMetadataStatus = (
  status: ComparisonProjectServingStatusRow,
): ComparisonProjectServingStatus => {
  return status.servingStatus === 'ready' && status.activeGeneration === null
    ? 'stale'
    : status.servingStatus === 'missing'
      ? 'refreshing'
      : status.servingStatus
}

const getComparisonProjectServingProgress = (
  status: ComparisonProjectServingStatusRow,
): ComparisonProjectServingProgress => {
  return {
    completedAt: status.servingCompletedAt,
    failedAt: status.servingFailedAt,
    generation: status.servingGeneration,
    lastError: status.servingError,
    lastProgressedAt: status.servingLastProgressedAt ?? null,
    phase: status.servingPhase ?? null,
    phaseStartedAt: status.servingPhaseStartedAt ?? null,
    stagedArticleCount: status.servingStagedArticleCount ?? 0,
    stagedCellCount: status.servingStagedCellCount ?? 0,
    stagedFilterMemberCount: status.servingStagedFilterMemberCount ?? 0,
    stagedFilterStatsCount: status.servingStagedFilterStatsCount ?? 0,
    startedAt: status.servingStartedAt,
  }
}

const getComparisonProjectServingMetadata = (status: ComparisonProjectServingStatusRow) => {
  const servingStatus = getComparisonProjectServingMetadataStatus(status)

  return {
    activeGeneration: status.activeGeneration,
    isServingReady: servingStatus === 'ready' && status.activeGeneration !== null,
    servingProgress: getComparisonProjectServingProgress(status),
    servingStatus,
    servingUpdatedAt: getComparisonProjectServingUpdatedAt(status),
  }
}

const getComparisonProjectServingQueueErrorMessage = (error: unknown) => {
  return error instanceof Error ? error.message : String(error)
}

const queueComparisonProjectServingRebuild = (comparisonProjectId: string) => {
  void comparisonProjectServingRebuildService
    .rebuildComparisonProjectServing(comparisonProjectId)
    .catch((error: unknown) => {
      console.error('[comparison-project-serving] rebuild failed', {
        comparisonProjectId,
        error: getComparisonProjectServingQueueErrorMessage(error),
      })
    })
}

const queueUnavailableComparisonProjectServingRebuild = (
  comparisonProject: Pick<ComparisonProjectScope, 'activeGeneration' | 'id' | 'servingProgress' | 'servingStatus'>,
) => {
  const latestProgressedAt =
    comparisonProject.servingProgress.lastProgressedAt ?? comparisonProject.servingProgress.startedAt
  const isMissingWithoutStartedBuild =
    comparisonProject.servingStatus === 'refreshing'
    && comparisonProject.activeGeneration === null
    && comparisonProject.servingProgress.generation === null
    && comparisonProject.servingProgress.startedAt === null
    && comparisonProject.servingProgress.lastProgressedAt === null
  const isStaleWithoutStartedBuild =
    comparisonProject.servingStatus === 'stale'
    && comparisonProject.servingProgress.generation === null
    && comparisonProject.servingProgress.startedAt === null
    && comparisonProject.servingProgress.lastProgressedAt === null
  const isRefreshingFromPreviousRouteLoad =
    comparisonProject.servingStatus === 'refreshing'
    && comparisonProject.servingProgress.generation !== null
    && latestProgressedAt !== null
    && latestProgressedAt < comparisonProjectRoutesLoadedAt

  if (!isMissingWithoutStartedBuild && !isStaleWithoutStartedBuild && !isRefreshingFromPreviousRouteLoad) {
    return
  }

  queueComparisonProjectServingRebuild(comparisonProject.id)
}

const markComparisonProjectServingStaleAndQueueRebuild = async (comparisonProjectId: string) => {
  await comparisonProjectServingRebuildService.markComparisonProjectServingStale(comparisonProjectId)
  queueComparisonProjectServingRebuild(comparisonProjectId)
}

const getStringArrayRowValue = <TRow extends Record<string, unknown>>(row: TRow, key: keyof TRow) => {
  const value = getJsonValue(row[key])
  return Array.isArray(value)
    ? value.filter((entry): entry is string => {
        return typeof entry === 'string'
      })
    : null
}

const getBooleanLiteral = (value: boolean) => {
  return value ? 'TRUE' : 'FALSE'
}

const getInClause = (values: string[]) => {
  return getQuotedStringList(values).join(', ')
}

const getTrimmedTextExistsClause = (column: string) => {
  return `NULLIF(TRIM(COALESCE(${column}, '')), '') IS NOT NULL`
}

const getCaseInsensitiveContainsClause = (column: string, searchValue: string) => {
  return `LOWER(COALESCE(${column}, '')) LIKE LOWER(${getSqlLiteral(`%${searchValue}%`)})`
}

const getArticleMatchesImportRouteClause = (articleAlias: string, routeIds: string[]) => {
  return routeIds.length === 0
    ? null
    : `EXISTS (
        SELECT 1
        FROM ${articleImportRouteTable} air
        WHERE air.article_id = ${articleAlias}.id
          AND air.import_route_id IN (${getInClause(routeIds)})
      )`
}

const getArticleMatchesProjectClause = (articleAlias: string, projectIds: string[]) => {
  return projectIds.length === 0
    ? null
    : `EXISTS (
        SELECT 1
        FROM ${projectArticleTable} pa
        WHERE pa.article_id = ${articleAlias}.id
          AND pa.project_id IN (${getInClause(projectIds)})
      )`
}

const getArticleInScopeClause = (
  articleAlias: string,
  routeIds: string[],
  projectIds: string[],
  useImportRoutesForScope: boolean,
) => {
  const importRouteClause = useImportRoutesForScope ? getArticleMatchesImportRouteClause(articleAlias, routeIds) : null
  const projectClause = getArticleMatchesProjectClause(articleAlias, projectIds)
  return importRouteClause && projectClause
    ? `(${importRouteClause} OR ${projectClause})`
    : (importRouteClause ?? projectClause)
}

const getWhereClause = (conditions: Array<string | null | undefined>) => {
  const filteredConditions = conditions.filter((condition): condition is string => {
    return Boolean(condition)
  })
  return filteredConditions.length > 0 ? `WHERE ${filteredConditions.join('\n  AND ')}` : ''
}

const getContentVariantClause = (tableAlias: string, contentVariant: ComparisonProjectContentVariant) => {
  return `(
    ${tableAlias}.use_title = ${getBooleanLiteral(contentVariant.useTitle)}
    AND ${tableAlias}.use_abstract = ${getBooleanLiteral(contentVariant.useAbstract)}
    AND ${tableAlias}.use_fulltext = ${getBooleanLiteral(contentVariant.useFulltext)}
    AND ${tableAlias}.use_fulltext_no_images = ${getBooleanLiteral(contentVariant.useFulltextNoImages)}
  )`
}

const getComparisonProjectContentClause = (tableAlias: string, contentVariants: ComparisonProjectContentVariant[]) => {
  return contentVariants.length === 0
    ? null
    : `(${contentVariants
        .map((contentVariant) => {
          return getContentVariantClause(tableAlias, contentVariant)
        })
        .join(' OR ')})`
}

const getRequestedComparisonProjectDifferenceFilter = (params: {
  differenceFilter?: ComparisonProjectDifferenceFilter
  showOnlyModelDifferences?: boolean
}) => {
  return params.differenceFilter ?? (params.showOnlyModelDifferences ? 'llm-vs-llm' : 'all')
}

const getComparisonProjectRecordValue = (row: ComparisonProjectRecordRow) => {
  return {
    ...row,
    modelIds: getStringArrayRowValue(row, 'modelIds'),
    humanJudgmentMode: row.humanJudgmentMode ?? 'prompt',
    createdAt: getRequiredDateValue(row.createdAt),
    updatedAt: getRequiredDateValue(row.updatedAt),
  }
}

const getComparisonProjectRecordSql = (comparisonProjectId: string) => {
  return `
    SELECT
      id,
      name,
      description,
      model_ids AS modelIds,
      compare_with_humans AS compareWithHumans,
      COALESCE(allow_conflict_resolution, FALSE) AS allowConflictResolution,
      human_judgment_mode AS humanJudgmentMode,
      summary_source_project_id AS summarySourceProjectId,
      use_title AS useTitle,
      use_abstract AS useAbstract,
      use_fulltext AS useFulltext,
      use_fulltext_no_images AS useFulltextNoImages,
      archived,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM ${comparisonProjectTable}
    WHERE id = ${getSqlLiteral(comparisonProjectId)}
    LIMIT 1
  `
}

const getComparisonProjectRecord = async (db: AppQueryRunner, comparisonProjectId: string) => {
  const [comparisonProjectRow] = await db.queryJson<ComparisonProjectRecordRow>(
    getComparisonProjectRecordSql(comparisonProjectId),
  )
  return comparisonProjectRow ?? null
}

const updateComparisonProjectTx = async (tx: AppTx, params: {comparisonProjectId: string; setParts: string[]}) => {
  await tx.run(`
    UPDATE ${comparisonProjectTable}
    SET ${params.setParts.join(', ')}
    WHERE id = ${getSqlLiteral(params.comparisonProjectId)}
  `)

  return getComparisonProjectRecord(tx, params.comparisonProjectId)
}

const isDefined = <T>(value: T | null | undefined): value is T => {
  return value !== null && value !== undefined
}

const getUniqueStringValues = (values: string[]) => {
  return Array.from(
    new Set(
      values
        .map((value) => {
          return value.trim()
        })
        .filter((value) => {
          return value !== ''
        }),
    ),
  )
}

const getUniquePromptSelections = (promptSelections: PromptSelection[]) => {
  const uniqueSelections = promptSelections.reduce<Map<string, PromptSelection>>((selectionMap, selection) => {
    if (!selectionMap.has(selection.promptId)) {
      selectionMap.set(selection.promptId, selection)
    }

    return selectionMap
  }, new Map<string, PromptSelection>())

  return Array.from(uniqueSelections.values()).sort((left, right) => {
    return left.order - right.order
  })
}

const getPromptLabel = (promptHeading: string | null, order: number) => {
  const trimmedHeading = promptHeading?.trim() ?? ''

  return trimmedHeading || `Prompt ${order + 1}`
}

const getComparisonProjectContentLabel = (settings: {
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
}) => {
  const textLabel =
    settings.useTitle || settings.useAbstract
      ? settings.useTitle && settings.useAbstract
        ? 'Article Title and Abstract'
        : settings.useTitle
          ? 'Article Title'
          : 'Article Abstract'
      : null
  const fulltextLabel = settings.useFulltextNoImages
    ? 'Use Full Text (without images)'
    : settings.useFulltext
      ? 'Use Full Text (with images)'
      : null
  const parts = [textLabel, fulltextLabel].filter(Boolean) as string[]

  return parts.length > 0 ? parts.join(' + ') : 'No content selected'
}

const getComparisonProjectContentVariants = (settings: {
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
}) => {
  return [
    settings.useTitle || settings.useAbstract
      ? {
          key: getComparisonProjectContentKey({
            useTitle: settings.useTitle,
            useAbstract: settings.useAbstract,
            useFulltext: false,
            useFulltextNoImages: false,
          }),
          label: getComparisonProjectContentLabel({
            useTitle: settings.useTitle,
            useAbstract: settings.useAbstract,
            useFulltext: false,
            useFulltextNoImages: false,
          }),
          useTitle: settings.useTitle,
          useAbstract: settings.useAbstract,
          useFulltext: false,
          useFulltextNoImages: false,
        }
      : null,
    settings.useFulltext
      ? {
          key: getComparisonProjectContentKey({
            useTitle: false,
            useAbstract: false,
            useFulltext: true,
            useFulltextNoImages: false,
          }),
          label: getComparisonProjectContentLabel({
            useTitle: false,
            useAbstract: false,
            useFulltext: true,
            useFulltextNoImages: false,
          }),
          useTitle: false,
          useAbstract: false,
          useFulltext: true,
          useFulltextNoImages: false,
        }
      : null,
    settings.useFulltextNoImages
      ? {
          key: getComparisonProjectContentKey({
            useTitle: false,
            useAbstract: false,
            useFulltext: false,
            useFulltextNoImages: true,
          }),
          label: getComparisonProjectContentLabel({
            useTitle: false,
            useAbstract: false,
            useFulltext: false,
            useFulltextNoImages: true,
          }),
          useTitle: false,
          useAbstract: false,
          useFulltext: false,
          useFulltextNoImages: true,
        }
      : null,
  ].filter(isDefined)
}

const getIsSummaryMode = (scope: Pick<ComparisonProjectScope, 'compareWithHumans' | 'humanJudgmentMode'>) => {
  return scope.compareWithHumans && scope.humanJudgmentMode === 'summary'
}

const getModelSelectionId = (modelRow: {
  id: string
  provider: string | null
  modelName: string | null
  version: string | null
}) => {
  const provider = modelRow.provider?.trim().toLowerCase() ?? ''
  const modelName = modelRow.modelName?.trim() ?? ''
  const version = modelRow.version?.trim() ?? ''

  return provider === 'codex' && modelName
    ? version
      ? `codex:${modelName}:${version}`
      : `codex:${modelName}`
    : modelRow.id
}

const getComparisonProjectsList = async (archived: boolean) => {
  const rows = await appDatabaseService.queryJson<{
    id: string
    name: string
    description: string | null
    compareWithHumans: boolean
    allowConflictResolution: boolean
    humanJudgmentMode: HumanJudgmentMode | null
    summarySourceProjectId: string | null
    useTitle: boolean
    useAbstract: boolean
    useFulltext: boolean
    useFulltextNoImages: boolean
    archived: boolean
    createdAt: unknown
    promptCount: number
    routeCount: number
  }>(`
    SELECT
      cp.id AS id,
      cp.name AS name,
      cp.description AS description,
      cp.compare_with_humans AS compareWithHumans,
      COALESCE(cp.allow_conflict_resolution, FALSE) AS allowConflictResolution,
      cp.human_judgment_mode AS humanJudgmentMode,
      cp.summary_source_project_id AS summarySourceProjectId,
      cp.use_title AS useTitle,
      cp.use_abstract AS useAbstract,
      cp.use_fulltext AS useFulltext,
      cp.use_fulltext_no_images AS useFulltextNoImages,
      cp.archived AS archived,
      cp.created_at AS createdAt,
      COALESCE(prompt_counts.promptCount, 0) AS promptCount,
      COALESCE(route_counts.routeCount, 0) AS routeCount
    FROM ${comparisonProjectTable} cp
    LEFT JOIN (
      SELECT comparison_project_id AS comparisonProjectId, COUNT(*) AS promptCount
      FROM ${comparisonProjectPromptTable}
      GROUP BY comparison_project_id
    ) prompt_counts ON prompt_counts.comparisonProjectId = cp.id
    LEFT JOIN (
      SELECT comparison_project_id AS comparisonProjectId, COUNT(*) AS routeCount
      FROM ${comparisonProjectImportRouteTable}
      GROUP BY comparison_project_id
    ) route_counts ON route_counts.comparisonProjectId = cp.id
    WHERE cp.archived = ${getBooleanLiteral(archived)}
    ORDER BY ${archived ? 'cp.created_at DESC' : 'cp.name ASC'}
  `)

  return rows.map((row) => {
    return {...row, humanJudgmentMode: row.humanJudgmentMode ?? 'prompt', createdAt: getDateValue(row.createdAt)}
  })
}

const getComparisonProjectSources = async (): Promise<ComparisonProjectSource[]> => {
  const projectRows = await appDatabaseService.queryJson<ComparisonProjectSource>(`
    SELECT
      p.id AS id,
      p.name AS name,
      p.description AS description,
      p.model_id AS modelId,
      TO_JSON(m.metadata_json) AS modelMetadataJson,
      COALESCE(m.display_name, m.name, m.remote_model_id) AS modelName,
      pc.provider_kind AS modelProvider,
      m.variant AS modelVersion,
      p.human_judgment_mode AS humanJudgmentMode,
      p.use_title AS useTitle,
      p.use_abstract AS useAbstract,
      p.use_fulltext AS useFulltext,
      p.use_fulltext_no_images AS useFulltextNoImages
    FROM ${projectTable} p
    INNER JOIN ${modelTable} m ON m.id = p.model_id
    LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
    WHERE p.archived = FALSE
    ORDER BY p.name ASC
  `)

  if (projectRows.length === 0) {
    return []
  }

  const projectIds = projectRows.map((projectRow) => {
    return projectRow.id
  })
  const [promptRows, routeRows] = await Promise.all([
    appDatabaseService.queryJson<{
      projectId: string
      promptId: string
      promptHeading: string | null
      order: number | null
      criteriaDisposition: ProjectPromptCriteriaDisposition | null
      criteriaSectionKey: string | null
      criteriaSectionLabel: string | null
    }>(`
      SELECT
        pp.project_id AS projectId,
        p.id AS promptId,
        p.prompt_heading AS promptHeading,
        pp.prompt_order AS "order",
        pp.criteria_disposition AS criteriaDisposition,
        pp.criteria_section_key AS criteriaSectionKey,
        pp.criteria_section_label AS criteriaSectionLabel
      FROM ${projectPromptTable} pp
      INNER JOIN ${promptTable} p ON p.id = pp.prompt_id
      WHERE pp.project_id IN (${getInClause(projectIds)})
        AND pp.enabled = TRUE
      ORDER BY pp.project_id ASC, pp.prompt_order ASC, p.created_at ASC
    `),
    appDatabaseService.queryJson<{projectId: string; route: string; name: string | null}>(`
      SELECT
        pir.project_id AS projectId,
        ir.route AS route,
        ir.name AS name
      FROM ${projectImportRouteTable} pir
      INNER JOIN ${importRouteTable} ir ON ir.id = pir.import_route_id
      WHERE pir.project_id IN (${getInClause(projectIds)})
      ORDER BY pir.project_id ASC, ir.route ASC
    `),
  ])
  const promptRowsByProjectId = promptRows.reduce<Map<string, typeof promptRows>>((rowMap, promptRow) => {
    const currentRows = rowMap.get(promptRow.projectId) ?? []
    currentRows.push(promptRow)
    rowMap.set(promptRow.projectId, currentRows)
    return rowMap
  }, new Map<string, typeof promptRows>())
  const routeRowsByProjectId = routeRows.reduce<Map<string, typeof routeRows>>((rowMap, routeRow) => {
    const currentRows = rowMap.get(routeRow.projectId) ?? []
    currentRows.push(routeRow)
    rowMap.set(routeRow.projectId, currentRows)
    return rowMap
  }, new Map<string, typeof routeRows>())

  return projectRows
    .map<ComparisonProjectSource | null>((projectRow) => {
      const sourcePromptRows = promptRowsByProjectId.get(projectRow.id) ?? []
      const sourceImportRouteRows = routeRowsByProjectId.get(projectRow.id) ?? []

      if (sourcePromptRows.length === 0) {
        return null
      }

      const {modelMetadataJson: _modelMetadataJson, ...sourceProjectRow} = projectRow

      const humanJudgmentMode = projectRow.humanJudgmentMode ?? 'prompt'

      return {
        ...sourceProjectRow,
        modelName: appendProviderModelThinkingBadgeLabel({
          label: projectRow.modelName,
          thinking: getProviderModelThinkingBadgeValue({
            provider: projectRow.modelProvider,
            thinking: getProviderModelMetadataOptions(getJsonValue(projectRow.modelMetadataJson)).thinking,
            version: projectRow.modelVersion,
          }),
        }),
        humanJudgmentMode,
        isSummaryCapable: humanJudgmentMode === 'summary',
        summarySourceProjectId: humanJudgmentMode === 'summary' ? projectRow.id : null,
        prompts: sourcePromptRows.map<ComparisonProjectSourcePrompt>((promptRow, index) => {
          return {
            id: promptRow.promptId,
            promptHeading: promptRow.promptHeading,
            order: promptRow.order ?? index,
            criteriaDisposition: promptRow.criteriaDisposition,
            criteriaSectionKey: promptRow.criteriaSectionKey,
            criteriaSectionLabel: promptRow.criteriaSectionLabel,
          }
        }),
        importRoutes: sourceImportRouteRows.map<ComparisonProjectSourceImportRoute>((routeRow) => {
          return {route: routeRow.route, name: routeRow.name}
        }),
      }
    })
    .filter(isDefined)
}

const getComparisonProjectSourceProjects = async (sourceProjectIds: string[]) => {
  if (sourceProjectIds.length === 0) {
    return []
  }

  const sourceProjectRows = await appDatabaseService.queryJson<
    Omit<ComparisonProjectLinkedSourceProject, 'humanJudgmentMode'> & {humanJudgmentMode: HumanJudgmentMode | null}
  >(`
    SELECT
      p.id AS id,
      p.name AS name,
      p.description AS description,
      p.model_id AS modelId,
      COALESCE(m.display_name, m.name, m.remote_model_id) AS modelName,
      p.human_judgment_mode AS humanJudgmentMode
    FROM ${projectTable} p
    INNER JOIN ${modelTable} m ON m.id = p.model_id
    WHERE p.id IN (${getInClause(sourceProjectIds)})
    ORDER BY p.name ASC
  `)
  const sourceProjectOrderLookup = sourceProjectIds.reduce<Record<string, number>>(
    (orderLookup, sourceProjectId, index) => {
      return {...orderLookup, [sourceProjectId]: index}
    },
    {},
  )

  return sourceProjectRows
    .map<ComparisonProjectLinkedSourceProject>((sourceProjectRow) => {
      return {...sourceProjectRow, humanJudgmentMode: sourceProjectRow.humanJudgmentMode ?? 'prompt'}
    })
    .sort((left, right) => {
      return (
        (sourceProjectOrderLookup[left.id] ?? Number.MAX_SAFE_INTEGER)
        - (sourceProjectOrderLookup[right.id] ?? Number.MAX_SAFE_INTEGER)
      )
    })
}

const getSortedUniqueStringValues = (values: string[]) => {
  return Array.from(new Set(values)).sort((left, right) => {
    return left.localeCompare(right)
  })
}

const getSummarySourceProject = async (summarySourceProjectId: string | null) => {
  if (!summarySourceProjectId) {
    return null
  }

  const [sourceProjectRow] = await appDatabaseService.queryJson<
    Omit<ComparisonProjectSummarySourceProject, 'humanJudgmentMode'> & {humanJudgmentMode: HumanJudgmentMode | null}
  >(`
    SELECT
      p.id AS id,
      p.name AS name,
      p.description AS description,
      p.model_id AS modelId,
      COALESCE(m.display_name, m.name, m.remote_model_id) AS modelName,
      p.human_judgment_mode AS humanJudgmentMode,
      p.use_title AS useTitle,
      p.use_abstract AS useAbstract,
      p.use_fulltext AS useFulltext,
      p.use_fulltext_no_images AS useFulltextNoImages
    FROM ${projectTable} p
    INNER JOIN ${modelTable} m ON m.id = p.model_id
    WHERE p.id = ${getSqlLiteral(summarySourceProjectId)}
    LIMIT 1
  `)

  return sourceProjectRow
    ? {...sourceProjectRow, humanJudgmentMode: sourceProjectRow.humanJudgmentMode ?? 'prompt'}
    : null
}

const getComparisonProjectSourceSummaryPromptConfigs = async (sourceProjectIds: string[]) => {
  if (sourceProjectIds.length === 0) {
    return []
  }

  const rows = await appDatabaseService.queryJson<{
    sourceProjectId: string
    id: string
    promptHeading: string | null
    type: string | null
    order: number | null
    criteriaDisposition: ProjectPromptCriteriaDisposition | null
    criteriaSectionKey: string | null
    criteriaSectionLabel: string | null
  }>(`
    SELECT
      pp.project_id AS sourceProjectId,
      p.id AS id,
      p.prompt_heading AS promptHeading,
      p.type AS type,
      pp.prompt_order AS "order",
      pp.criteria_disposition AS criteriaDisposition,
      pp.criteria_section_key AS criteriaSectionKey,
      pp.criteria_section_label AS criteriaSectionLabel
    FROM ${projectPromptTable} pp
    INNER JOIN ${promptTable} p ON p.id = pp.prompt_id
    WHERE pp.project_id IN (${getInClause(sourceProjectIds)})
      AND pp.enabled = TRUE
      AND pp.criteria_disposition IS NOT NULL
      AND pp.criteria_section_key IS NOT NULL
    ORDER BY pp.project_id ASC, pp.prompt_order ASC, p.created_at ASC
  `)
  const fallbackOrderByProjectId = new Map<string, number>()

  return rows.map<ComparisonProjectSourceSummaryPromptConfig>((row) => {
    const fallbackOrder = fallbackOrderByProjectId.get(row.sourceProjectId) ?? 0
    const order = row.order ?? fallbackOrder
    fallbackOrderByProjectId.set(row.sourceProjectId, fallbackOrder + 1)

    return {
      id: row.id,
      sourceProjectId: row.sourceProjectId,
      promptHeading: row.promptHeading,
      promptLabel: getPromptLabel(row.promptHeading, order),
      type: row.type,
      order,
      criteriaDisposition: row.criteriaDisposition,
      criteriaSectionKey: row.criteriaSectionKey,
      criteriaSectionLabel: row.criteriaSectionLabel,
    }
  })
}

const getComparisonProjectConflictResolutionImportSources = async () => {
  const rows = await appDatabaseService.queryJson<ComparisonProjectConflictResolutionImportSourceQueryRow>(
    getComparisonProjectConflictResolutionImportSourcesSql({
      comparisonProjectConflictResolutionTable,
      comparisonProjectTable,
    }),
  )

  return rows.map(getComparisonProjectConflictResolutionImportSourceValue)
}

const getValidatedComparisonSourceProjectIds = async (db: AppQueryRunner, sourceProjectIds: string[]) => {
  const uniqueSourceProjectIds = getUniqueStringValues(sourceProjectIds)

  if (uniqueSourceProjectIds.length === 0) {
    return []
  }

  const sourceProjectRows = await db.queryJson<{id: string}>(`
    SELECT id
    FROM ${projectTable}
    WHERE id IN (${getInClause(uniqueSourceProjectIds)})
      AND archived = FALSE
  `)

  if (sourceProjectRows.length !== uniqueSourceProjectIds.length) {
    throw new Error('One or more selected source projects are invalid')
  }

  return uniqueSourceProjectIds
}

const getSelectedComparisonProjectSources = (sources: ComparisonProjectSource[], sourceProjectIds: string[]) => {
  const selectedSourceProjects = sourceProjectIds.reduce<ComparisonProjectSource[]>(
    (selectedProjects, sourceProjectId) => {
      const sourceProject = sources.find((candidateSourceProject) => {
        return candidateSourceProject.id === sourceProjectId
      })

      return sourceProject ? [...selectedProjects, sourceProject] : selectedProjects
    },
    [],
  )

  if (selectedSourceProjects.length !== sourceProjectIds.length) {
    throw new Error('One or more selected source projects were not found')
  }

  return selectedSourceProjects
}

const getValidatedCreateFromProjectSummarySelections = (params: {
  selectedSourceProjects: ComparisonProjectSource[]
  summarySourceProjectId: string
}) => {
  const summarySourceProject = params.selectedSourceProjects.find((sourceProject) => {
    return sourceProject.id === params.summarySourceProjectId
  })

  if (!summarySourceProject) {
    throw new Error('Summary source project must be included in the selected projects')
  }

  if (
    params.selectedSourceProjects.some((sourceProject) => {
      return !sourceProject.isSummaryCapable
    })
  ) {
    throw new Error('Additional projects require summary-capable source projects')
  }

  const summaryPromptSelections = getSourceProjectSummaryPromptSelections(summarySourceProject)

  if (summaryPromptSelections.length === 0) {
    throw new Error('Selected summary source project has no prompts with summary criteria metadata')
  }

  const sourceProjectWithoutSummaryPrompts = params.selectedSourceProjects.find((sourceProject) => {
    return getSourceProjectSummaryPromptSelections(sourceProject).length === 0
  })

  if (sourceProjectWithoutSummaryPrompts) {
    throw new Error('All selected summary projects must have prompts with summary criteria metadata')
  }

  return summaryPromptSelections
}

const getHasSameStringValues = (left: string[], right: string[]) => {
  const leftValues = getSortedUniqueStringValues(left)
  const rightValues = getSortedUniqueStringValues(right)

  return (
    leftValues.length === rightValues.length
    && leftValues.every((value, index) => {
      return value === rightValues[index]
    })
  )
}

const getNormalizedComparisonScopeName = (value: string) => {
  return value.trim().toLowerCase()
}

const getInferredSourceProjectId = async (
  comparisonProjectRow: {
    name: string
    useTitle: boolean
    useAbstract: boolean
    useFulltext: boolean
    useFulltextNoImages: boolean
  },
  promptConfigs: ComparisonProjectPromptConfig[],
  importRouteIds: string[],
) => {
  if (promptConfigs.length === 0) {
    return null
  }

  const candidateProjects = await appDatabaseService.queryJson<{id: string; name: string}>(`
    SELECT
      id,
      name
    FROM ${projectTable}
    WHERE use_title = ${getBooleanLiteral(comparisonProjectRow.useTitle)}
      AND use_abstract = ${getBooleanLiteral(comparisonProjectRow.useAbstract)}
      AND use_fulltext = ${getBooleanLiteral(comparisonProjectRow.useFulltext)}
      AND use_fulltext_no_images = ${getBooleanLiteral(comparisonProjectRow.useFulltextNoImages)}
  `)

  if (candidateProjects.length === 0) {
    return null
  }

  const candidateProjectIds = candidateProjects.map((candidateProject) => {
    return candidateProject.id
  })
  const [candidatePromptRows, candidateRouteRows] = await Promise.all([
    appDatabaseService.queryJson<{projectId: string; promptId: string}>(`
      SELECT project_id AS projectId, prompt_id AS promptId
      FROM ${projectPromptTable}
      WHERE project_id IN (${getInClause(candidateProjectIds)})
        AND enabled = TRUE
    `),
    appDatabaseService.queryJson<{projectId: string; importRouteId: string}>(`
      SELECT project_id AS projectId, import_route_id AS importRouteId
      FROM ${projectImportRouteTable}
      WHERE project_id IN (${getInClause(candidateProjectIds)})
    `),
  ])
  const promptIdsByProjectId = candidatePromptRows.reduce<Map<string, string[]>>((rowMap, promptRow) => {
    const currentPromptIds = rowMap.get(promptRow.projectId) ?? []
    currentPromptIds.push(promptRow.promptId)
    rowMap.set(promptRow.projectId, currentPromptIds)
    return rowMap
  }, new Map<string, string[]>())
  const routeIdsByProjectId = candidateRouteRows.reduce<Map<string, string[]>>((rowMap, routeRow) => {
    const currentRouteIds = rowMap.get(routeRow.projectId) ?? []
    currentRouteIds.push(routeRow.importRouteId)
    rowMap.set(routeRow.projectId, currentRouteIds)
    return rowMap
  }, new Map<string, string[]>())
  const comparisonPromptIds = promptConfigs.map((promptConfig) => {
    return promptConfig.id
  })
  const exactCandidates = candidateProjects.filter((candidateProject) => {
    const candidatePromptIds = promptIdsByProjectId.get(candidateProject.id) ?? []
    const candidateRouteIds = routeIdsByProjectId.get(candidateProject.id) ?? []

    return (
      getHasSameStringValues(candidatePromptIds, comparisonPromptIds)
      && getHasSameStringValues(candidateRouteIds, importRouteIds)
    )
  })
  const comparisonProjectName = getNormalizedComparisonScopeName(comparisonProjectRow.name)
  const nameMatchedCandidates = exactCandidates.filter((candidateProject) => {
    const candidateProjectName = getNormalizedComparisonScopeName(candidateProject.name)

    return (
      candidateProjectName.length > 0
      && (comparisonProjectName === candidateProjectName
        || comparisonProjectName.startsWith(`${candidateProjectName} |`)
        || comparisonProjectName.includes(candidateProjectName))
    )
  })
  const [matchedCandidate] = nameMatchedCandidates

  return nameMatchedCandidates.length === 1 ? (matchedCandidate?.id ?? null) : null
}

const getArticleScopeConditions = (
  routeIds: string[],
  sourceProjectIds: string[],
  useImportRoutesForScope: boolean,
  searchTitle?: string | null,
) => {
  const trimmedSearchTitle = searchTitle?.trim() ?? ''
  const scopeCondition = getArticleInScopeClause('a', routeIds, sourceProjectIds, useImportRoutesForScope)

  return [
    scopeCondition,
    trimmedSearchTitle ? getCaseInsensitiveContainsClause('a.article_title', trimmedSearchTitle) : null,
  ].filter(isDefined)
}

const getComparisonProjectModels = async (
  comparisonProjectRow: {
    modelIds: string[] | null
    sourceProjectIds: string[]
    useImportRoutesForScope: boolean
    contentVariants: ComparisonProjectContentVariant[]
  },
  promptIds: string[],
  importRouteIds: string[],
) => {
  const selectedModelIds = comparisonProjectRow.modelIds ?? []

  if (selectedModelIds.length > 0) {
    const modelRows = await appDatabaseService.queryJson<ComparisonProjectModelConfig>(`
      SELECT m.id AS id, m.name AS name, TO_JSON(m.metadata_json) AS metadataJson, pc.provider_kind AS provider, m.variant AS version
      FROM ${modelTable} m
      LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
      WHERE m.id IN (${getInClause(selectedModelIds)})
    `)
    const orderLookup = selectedModelIds.reduce<Record<string, number>>((acc, modelId, index) => {
      return {...acc, [modelId]: index}
    }, {})

    return modelRows.sort((left, right) => {
      return (orderLookup[left.id] ?? Number.MAX_SAFE_INTEGER) - (orderLookup[right.id] ?? Number.MAX_SAFE_INTEGER)
    })
  }

  if (promptIds.length === 0) {
    return []
  }

  const contentCondition = getComparisonProjectContentClause('j', comparisonProjectRow.contentVariants)

  if (!contentCondition) {
    return []
  }

  const articleScopeConditions = getArticleScopeConditions(
    importRouteIds,
    comparisonProjectRow.sourceProjectIds,
    comparisonProjectRow.useImportRoutesForScope,
  )
  return appDatabaseService.queryJson<ComparisonProjectModelConfig>(`
    SELECT m.id AS id, m.name AS name, TO_JSON(m.metadata_json) AS metadataJson, pc.provider_kind AS provider, m.variant AS version
    FROM ${judgmentTable} j
    INNER JOIN ${modelTable} m ON m.id = j.model_id
    LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
    INNER JOIN ${articleTable} a ON a.id = j.article_id
    ${getWhereClause([
      `j.prompt_id IN (${getInClause(promptIds)})`,
      'j.deleted_at IS NULL',
      contentCondition,
      ...articleScopeConditions,
    ])}
    GROUP BY m.id, m.name, m.metadata_json, pc.provider_kind, m.variant
    ORDER BY m.name ASC
  `)
}

const getComparisonProjectColumns = (
  promptRows: ComparisonProjectPromptConfig[],
  modelRows: ComparisonProjectModelConfig[],
  contentVariants: ComparisonProjectContentVariant[],
  compareWithHumans: boolean,
  humanJudgmentMode: HumanJudgmentMode,
  summarySourceProjectId: string | null,
  summarySourceProject: ComparisonProjectSummarySourceProject | null,
  sourceProjects: ComparisonProjectLinkedSourceProject[],
  useSourceProjectLlmColumns: boolean,
) => {
  const modelRowsById = modelRows.reduce<Map<string, ComparisonProjectModelConfig>>((rowMap, modelRow) => {
    rowMap.set(modelRow.id, modelRow)
    return rowMap
  }, new Map<string, ComparisonProjectModelConfig>())
  const sourceProjectsById = sourceProjects.reduce<Map<string, ComparisonProjectLinkedSourceProject>>(
    (rowMap, sourceProject) => {
      rowMap.set(sourceProject.id, sourceProject)
      return rowMap
    },
    new Map<string, ComparisonProjectLinkedSourceProject>(),
  )
  const shownPromptRows =
    compareWithHumans && humanJudgmentMode === 'summary'
      ? [{id: summaryPromptId, promptLabel: summaryPromptLabel}]
      : promptRows
  const sourceProjectLlmColumns = useSourceProjectLlmColumns
    ? sourceProjects.flatMap((sourceProject) => {
        const modelRow = modelRowsById.get(sourceProject.modelId)

        return modelRow
          ? contentVariants.map<ComparisonProjectJudgmentsColumn>((contentVariant) => {
              return {
                id: getComparisonProjectColumnId(
                  'llm',
                  summaryPromptId,
                  modelRow.id,
                  contentVariant.key,
                  sourceProject.id,
                ),
                kind: 'llm',
                promptId: summaryPromptId,
                promptLabel: summaryPromptLabel,
                modelId: modelRow.id,
                modelLabel: appendProviderModelThinkingBadgeLabel({
                  label: modelRow.name,
                  thinking: getProviderModelThinkingBadgeValue({
                    provider: modelRow.provider,
                    thinking: getProviderModelMetadataOptions(getJsonValue(modelRow.metadataJson)).thinking,
                    version: modelRow.version,
                  }),
                }),
                contentLabel: contentVariant.label,
                sourceProjectId: sourceProject.id,
                sourceProjectName: sourceProject.name,
              }
            })
          : []
      })
    : []
  const modelLlmColumns = shownPromptRows.flatMap((promptRow) => {
    return modelRows.flatMap((modelRow) => {
      return contentVariants.map<ComparisonProjectJudgmentsColumn>((contentVariant) => {
        return {
          id: getComparisonProjectColumnId('llm', promptRow.id, modelRow.id, contentVariant.key),
          kind: 'llm',
          promptId: promptRow.id,
          promptLabel: promptRow.promptLabel,
          modelId: modelRow.id,
          modelLabel: appendProviderModelThinkingBadgeLabel({
            label: modelRow.name,
            thinking: getProviderModelThinkingBadgeValue({
              provider: modelRow.provider,
              thinking: getProviderModelMetadataOptions(getJsonValue(modelRow.metadataJson)).thinking,
              version: modelRow.version,
            }),
          }),
          contentLabel: contentVariant.label,
          sourceProjectId: null,
          sourceProjectName: null,
        }
      })
    })
  })
  const llmColumns = sourceProjectLlmColumns.length > 0 ? sourceProjectLlmColumns : modelLlmColumns
  const humanSourceProject = summarySourceProjectId ? sourceProjectsById.get(summarySourceProjectId) : null
  const humanSourceProjectName = summarySourceProject?.name ?? humanSourceProject?.name ?? null
  const humanContentLabel =
    humanJudgmentMode === 'summary' && summarySourceProject
      ? getComparisonProjectContentLabel(summarySourceProject)
      : null
  const humanColumns = compareWithHumans
    ? shownPromptRows.map<ComparisonProjectJudgmentsColumn>((promptRow) => {
        return {
          id: getComparisonProjectColumnId('human', promptRow.id),
          kind: 'human',
          promptId: promptRow.id,
          promptLabel: promptRow.promptLabel,
          modelId: null,
          modelLabel: 'Human',
          contentLabel: humanContentLabel,
          sourceProjectId: humanJudgmentMode === 'summary' ? summarySourceProjectId : null,
          sourceProjectName: humanJudgmentMode === 'summary' ? humanSourceProjectName : null,
        }
      })
    : []

  return [...llmColumns, ...humanColumns]
}

const getComparisonProjectScope = async (comparisonProjectId: string): Promise<ComparisonProjectScope | null> => {
  const [comparisonProjectRow] = await appDatabaseService.queryJson<{
    id: string
    name: string
    description: string | null
    compareWithHumans: boolean
    allowConflictResolution: boolean
    humanJudgmentMode: HumanJudgmentMode | null
    summarySourceProjectId: string | null
    useTitle: boolean
    useAbstract: boolean
    useFulltext: boolean
    useFulltextNoImages: boolean
    archived: boolean
    createdAt: unknown
    modelIds: unknown
  }>(`
    SELECT
      id,
      name,
      description,
      compare_with_humans AS compareWithHumans,
      COALESCE(allow_conflict_resolution, FALSE) AS allowConflictResolution,
      human_judgment_mode AS humanJudgmentMode,
      summary_source_project_id AS summarySourceProjectId,
      use_title AS useTitle,
      use_abstract AS useAbstract,
      use_fulltext AS useFulltext,
      use_fulltext_no_images AS useFulltextNoImages,
      archived,
      created_at AS createdAt,
      model_ids AS modelIds
    FROM ${comparisonProjectTable}
    WHERE id = ${getSqlLiteral(comparisonProjectId)}
    LIMIT 1
  `)

  if (!comparisonProjectRow) {
    return null
  }

  const normalizedComparisonProjectRow = {
    ...comparisonProjectRow,
    createdAt: getRequiredDateValue(comparisonProjectRow.createdAt),
    modelIds: getStringArrayRowValue(comparisonProjectRow, 'modelIds'),
    humanJudgmentMode: comparisonProjectRow.humanJudgmentMode ?? 'prompt',
  }
  const [promptRows, routeRows, sourceProjectLinkRows, servingStatus] = await Promise.all([
    appDatabaseService.queryJson<{
      id: string
      promptHeading: string | null
      type: string | null
      order: number | null
      criteriaDisposition: ProjectPromptCriteriaDisposition | null
      criteriaSectionKey: string | null
      criteriaSectionLabel: string | null
    }>(`
      SELECT
        p.id AS id,
        p.prompt_heading AS promptHeading,
        p.type AS type,
        cpp.prompt_order AS "order",
        cpp.criteria_disposition AS criteriaDisposition,
        cpp.criteria_section_key AS criteriaSectionKey,
        cpp.criteria_section_label AS criteriaSectionLabel
      FROM ${comparisonProjectPromptTable} cpp
      INNER JOIN ${promptTable} p ON p.id = cpp.prompt_id
      WHERE cpp.comparison_project_id = ${getSqlLiteral(comparisonProjectId)}
      ORDER BY cpp.prompt_order ASC, p.created_at ASC
    `),
    appDatabaseService.queryJson<{importRouteId: string}>(`
      SELECT import_route_id AS importRouteId
      FROM ${comparisonProjectImportRouteTable}
      WHERE comparison_project_id = ${getSqlLiteral(comparisonProjectId)}
    `),
    appDatabaseService.queryJson<{sourceProjectId: string}>(`
      SELECT source_project_id AS sourceProjectId
      FROM ${comparisonProjectSourceProjectTable}
      WHERE comparison_project_id = ${getSqlLiteral(comparisonProjectId)}
    `),
    comparisonProjectServingRebuildService.getComparisonProjectServingStatus(comparisonProjectId),
  ])

  const promptConfigs = promptRows.map<ComparisonProjectPromptConfig>((promptRow, index) => {
    const order = promptRow.order ?? index

    return {
      id: promptRow.id,
      promptHeading: promptRow.promptHeading,
      promptLabel: getPromptLabel(promptRow.promptHeading, order),
      type: promptRow.type,
      order,
      criteriaDisposition: promptRow.criteriaDisposition,
      criteriaSectionKey: promptRow.criteriaSectionKey,
      criteriaSectionLabel: promptRow.criteriaSectionLabel,
    }
  })
  const importRouteIds = routeRows.map((routeRow) => {
    return routeRow.importRouteId
  })
  const linkedSourceProjectIds = sourceProjectLinkRows.map((sourceProjectLinkRow) => {
    return sourceProjectLinkRow.sourceProjectId
  })
  const fallbackSourceProjectId =
    linkedSourceProjectIds.length > 0
      ? null
      : (normalizedComparisonProjectRow.summarySourceProjectId
        ?? (await getInferredSourceProjectId(normalizedComparisonProjectRow, promptConfigs, importRouteIds)))
  const sourceProjectIds =
    linkedSourceProjectIds.length > 0
      ? linkedSourceProjectIds
      : fallbackSourceProjectId
        ? [fallbackSourceProjectId]
        : []
  const useImportRoutesForScope = linkedSourceProjectIds.length === 0
  const contentVariants = getComparisonProjectContentVariants(normalizedComparisonProjectRow)
  const useSourceProjectLlmColumns = getIsSummaryMode(normalizedComparisonProjectRow) && !useImportRoutesForScope
  const sourceProjectSummaryPrompts = useSourceProjectLlmColumns
    ? await getComparisonProjectSourceSummaryPromptConfigs(sourceProjectIds)
    : []
  const modelPromptConfigs = sourceProjectSummaryPrompts.length > 0 ? sourceProjectSummaryPrompts : promptConfigs
  const [summarySourceProject, sourceProjects, modelRows] = await Promise.all([
    getSummarySourceProject(normalizedComparisonProjectRow.summarySourceProjectId),
    getComparisonProjectSourceProjects(sourceProjectIds),
    getComparisonProjectModels(
      {...normalizedComparisonProjectRow, sourceProjectIds, useImportRoutesForScope, contentVariants},
      modelPromptConfigs.map((prompt) => {
        return prompt.id
      }),
      importRouteIds,
    ),
  ])
  const columns = getComparisonProjectColumns(
    promptConfigs,
    modelRows,
    contentVariants,
    normalizedComparisonProjectRow.compareWithHumans,
    normalizedComparisonProjectRow.humanJudgmentMode,
    normalizedComparisonProjectRow.summarySourceProjectId,
    summarySourceProject,
    sourceProjects,
    useSourceProjectLlmColumns,
  )

  return {
    ...normalizedComparisonProjectRow,
    ...getComparisonProjectServingMetadata(servingStatus),
    sourceProjectIds,
    useImportRoutesForScope,
    summarySourceProject,
    sourceProjects,
    contentVariants,
    prompts: promptConfigs,
    sourceProjectSummaryPrompts,
    models: modelRows,
    importRouteIds,
    columns,
  }
}

const getComparisonProjectEditFormData = async (comparisonProjectId: string) => {
  const [comparisonProjectRow] = await appDatabaseService.queryJson<{
    id: string
    name: string
    description: string | null
    compareWithHumans: boolean
    humanJudgmentMode: HumanJudgmentMode | null
    summarySourceProjectId: string | null
    updatedAt: unknown
    modelIds: unknown
    useTitle: boolean
    useAbstract: boolean
    useFulltext: boolean
    useFulltextNoImages: boolean
  }>(`
    SELECT
      id,
      name,
      description,
      compare_with_humans AS compareWithHumans,
      COALESCE(allow_conflict_resolution, FALSE) AS allowConflictResolution,
      human_judgment_mode AS humanJudgmentMode,
      summary_source_project_id AS summarySourceProjectId,
      updated_at AS updatedAt,
      model_ids AS modelIds,
      use_title AS useTitle,
      use_abstract AS useAbstract,
      use_fulltext AS useFulltext,
      use_fulltext_no_images AS useFulltextNoImages
    FROM ${comparisonProjectTable}
    WHERE id = ${getSqlLiteral(comparisonProjectId)}
    LIMIT 1
  `)

  if (!comparisonProjectRow) {
    return null
  }

  const normalizedComparisonProjectRow = {
    ...comparisonProjectRow,
    updatedAt: getRequiredDateValue(comparisonProjectRow.updatedAt),
    modelIds: getStringArrayRowValue(comparisonProjectRow, 'modelIds'),
    humanJudgmentMode: comparisonProjectRow.humanJudgmentMode ?? 'prompt',
  }
  const configuredModelIds = normalizedComparisonProjectRow.modelIds ?? []
  const configuredModelRows =
    configuredModelIds.length > 0
      ? await appDatabaseService.queryJson<{
          id: string
          provider: string | null
          modelName: string | null
          version: string | null
        }>(`
          SELECT
            m.id AS id,
            pc.provider_kind AS provider,
            m.remote_model_id AS modelName,
            m.variant AS version
          FROM ${modelTable} m
          LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
          WHERE m.id IN (${getInClause(configuredModelIds)})
        `)
      : []
  const modelRowsById = configuredModelRows.reduce<Map<string, (typeof configuredModelRows)[number]>>(
    (rowMap, modelRow) => {
      rowMap.set(modelRow.id, modelRow)
      return rowMap
    },
    new Map<string, (typeof configuredModelRows)[number]>(),
  )
  const availablePromptsQuery =
    normalizedComparisonProjectRow.humanJudgmentMode === 'summary'
    && normalizedComparisonProjectRow.summarySourceProjectId
      ? `
      SELECT
        p.id AS id,
        p.original_text AS originalText,
        p.prompt_heading AS promptHeading,
        p.type,
        p.created_at AS createdAt,
        p.archived AS archived
      FROM ${projectPromptTable} pp
      INNER JOIN ${promptTable} p ON p.id = pp.prompt_id
      WHERE pp.project_id = ${getSqlLiteral(normalizedComparisonProjectRow.summarySourceProjectId)}
        AND pp.enabled = TRUE
        AND p.archived = FALSE
      ORDER BY pp.prompt_order ASC, p.created_at ASC
    `
      : `
      SELECT
        id,
        original_text AS originalText,
        prompt_heading AS promptHeading,
        type,
        created_at AS createdAt,
        archived
      FROM ${promptTable}
      WHERE archived = FALSE
      ORDER BY created_at DESC
    `

  const [selectedPromptRows, availablePromptRows, sourceProjectLinkRows] = await Promise.all([
    appDatabaseService.queryJson<{
      id: string
      originalText: string
      promptHeading: string | null
      type: string | null
      createdAt: unknown
      archived: boolean
      order: number | null
    }>(`
      SELECT
        p.id AS id,
        p.original_text AS originalText,
        p.prompt_heading AS promptHeading,
        p.type AS type,
        p.created_at AS createdAt,
        p.archived AS archived,
        cpp.prompt_order AS "order"
      FROM ${comparisonProjectPromptTable} cpp
      INNER JOIN ${promptTable} p ON p.id = cpp.prompt_id
      WHERE cpp.comparison_project_id = ${getSqlLiteral(comparisonProjectId)}
      ORDER BY cpp.prompt_order ASC, p.created_at ASC
    `),
    appDatabaseService.queryJson<{
      id: string
      originalText: string
      promptHeading: string | null
      type: string | null
      createdAt: unknown
      archived: boolean
    }>(availablePromptsQuery),
    appDatabaseService.queryJson<{sourceProjectId: string}>(`
      SELECT source_project_id AS sourceProjectId
      FROM ${comparisonProjectSourceProjectTable}
      WHERE comparison_project_id = ${getSqlLiteral(comparisonProjectId)}
    `),
  ])
  const sourceProjectIds = sourceProjectLinkRows.map((sourceProjectLinkRow) => {
    return sourceProjectLinkRow.sourceProjectId
  })
  const normalizedSelectedPromptRows = selectedPromptRows.map((promptRow) => {
    return {...promptRow, createdAt: getRequiredDateValue(promptRow.createdAt)}
  })
  const normalizedAvailablePromptRows = availablePromptRows.map((promptRow) => {
    return {...promptRow, createdAt: getRequiredDateValue(promptRow.createdAt)}
  })
  const selectedPromptIds = new Set(
    normalizedSelectedPromptRows.map((promptRow) => {
      return promptRow.id
    }),
  )
  const availablePrompts = [
    ...normalizedSelectedPromptRows.map<ComparisonProjectEditPrompt>((promptRow) => {
      return {
        id: promptRow.id,
        originalText: promptRow.originalText,
        promptHeading: promptRow.promptHeading,
        type: promptRow.type,
        createdAt: promptRow.createdAt,
        archived: promptRow.archived,
      }
    }),
    ...normalizedAvailablePromptRows
      .filter((promptRow) => {
        return !selectedPromptIds.has(promptRow.id)
      })
      .map<ComparisonProjectEditPrompt>((promptRow) => {
        return {
          id: promptRow.id,
          originalText: promptRow.originalText,
          promptHeading: promptRow.promptHeading,
          type: promptRow.type,
          createdAt: promptRow.createdAt,
          archived: promptRow.archived,
        }
      }),
  ]
  const [summarySourceProject, sourceProjects] = await Promise.all([
    getSummarySourceProject(normalizedComparisonProjectRow.summarySourceProjectId),
    getComparisonProjectSourceProjects(sourceProjectIds),
  ])

  return {
    ...normalizedComparisonProjectRow,
    summarySourceProject,
    sourceProjectIds,
    sourceProjects,
    selectedModelIds: configuredModelIds
      .map((modelId) => {
        const modelRow = modelRowsById.get(modelId)
        return modelRow ? getModelSelectionId(modelRow) : modelId
      })
      .filter(Boolean),
    promptSelections: normalizedSelectedPromptRows.map((promptRow, index) => {
      return {promptId: promptRow.id, order: promptRow.order ?? index}
    }),
    availablePrompts,
  }
}

const getComparisonProjectLlmRows = async (scope: ComparisonProjectScope, articleIds: string[]) => {
  const summarySourcePromptIds =
    getIsSummaryMode(scope) && !scope.useImportRoutesForScope
      ? scope.sourceProjectSummaryPrompts.map((prompt) => {
          return prompt.id
        })
      : []
  const fallbackPromptIds = scope.prompts.map((prompt) => {
    return prompt.id
  })
  const promptIds = getUniqueStringValues(
    summarySourcePromptIds.length > 0 ? summarySourcePromptIds : fallbackPromptIds,
  )
  const modelIds = scope.models.map((model) => {
    return model.id
  })

  if (articleIds.length === 0 || promptIds.length === 0 || modelIds.length === 0) {
    return []
  }

  const contentCondition = getComparisonProjectContentClause('j', scope.contentVariants)

  if (!contentCondition) {
    return []
  }

  const rows = await appDatabaseService.queryJson<{
    createdAt: unknown
    articleId: string
    promptId: string
    modelId: string
    answeredOriginal: string | null
    answeredOriginalAsArray: unknown
    useTitle: boolean
    useAbstract: boolean
    useFulltext: boolean
    useFulltextNoImages: boolean
  }>(`
    SELECT
      created_at AS createdAt,
      article_id AS articleId,
      prompt_id AS promptId,
      model_id AS modelId,
      answered_original AS answeredOriginal,
      answered_original_as_array AS answeredOriginalAsArray,
      use_title AS useTitle,
      use_abstract AS useAbstract,
      use_fulltext AS useFulltext,
      use_fulltext_no_images AS useFulltextNoImages
    FROM ${judgmentTable} j
    ${getWhereClause([
      `j.article_id IN (${getInClause(articleIds)})`,
      `j.prompt_id IN (${getInClause(promptIds)})`,
      `j.model_id IN (${getInClause(modelIds)})`,
      'j.deleted_at IS NULL',
      contentCondition,
    ])}
  `)

  return rows
    .map<ComparisonProjectLlmRow>((row) => {
      return {
        ...row,
        createdAt: getRequiredDateValue(row.createdAt),
        sourceProjectId: null,
        answeredOriginalAsArray: getStringArrayRowValue(row, 'answeredOriginalAsArray'),
      }
    })
    .filter((row) => {
      return hasAnyJudgmentAnswer(row)
    })
}

const getSummaryCriteria = (prompts: ComparisonProjectPromptConfig[]) => {
  return prompts.map((prompt) => {
    return {promptId: prompt.id, criteriaDisposition: prompt.criteriaDisposition}
  })
}

const getComparisonProjectSummaryPromptGroups = (
  scope: ComparisonProjectScope,
): ComparisonProjectSummaryPromptGroup[] => {
  if (!getIsSummaryMode(scope) || scope.useImportRoutesForScope) {
    return [{sourceProjectId: null, modelId: null, prompts: scope.prompts}]
  }

  const promptRowsBySourceProjectId = scope.sourceProjectSummaryPrompts.reduce<
    Map<string, ComparisonProjectPromptConfig[]>
  >((rowMap, prompt) => {
    const currentPrompts = rowMap.get(prompt.sourceProjectId) ?? []
    rowMap.set(prompt.sourceProjectId, [...currentPrompts, prompt])
    return rowMap
  }, new Map<string, ComparisonProjectPromptConfig[]>())
  const sourceProjectGroups = scope.sourceProjects.reduce<ComparisonProjectSummaryPromptGroup[]>(
    (groups, sourceProject) => {
      const prompts = promptRowsBySourceProjectId.get(sourceProject.id) ?? []

      return prompts.length > 0
        ? [...groups, {sourceProjectId: sourceProject.id, modelId: sourceProject.modelId, prompts}]
        : groups
    },
    [],
  )

  return sourceProjectGroups.length > 0
    ? sourceProjectGroups
    : [{sourceProjectId: null, modelId: null, prompts: scope.prompts}]
}

const getComparisonProjectLlmRowsForSummaryGroup = (
  rows: ComparisonProjectLlmRow[],
  summaryPromptGroup: ComparisonProjectSummaryPromptGroup,
) => {
  const promptIds = new Set(
    summaryPromptGroup.prompts.map((prompt) => {
      return prompt.id
    }),
  )

  return rows.filter((row) => {
    return (
      promptIds.has(row.promptId) && (summaryPromptGroup.modelId === null || row.modelId === summaryPromptGroup.modelId)
    )
  })
}

const getComparisonProjectLlmSummaryRow = (
  rows: ComparisonProjectLlmRow[],
  summaryPromptGroup: ComparisonProjectSummaryPromptGroup,
) => {
  const groupRows = getComparisonProjectLlmRowsForSummaryGroup(rows, summaryPromptGroup)
  const [firstRow] = groupRows

  if (!firstRow) {
    return null
  }

  const normalizedAnswers = Array.from(getLatestComparisonProjectLlmRowsByPromptId(groupRows).values()).reduce<
    Record<string, 'yes' | 'no' | 'maybe' | null>
  >((answerMap, row) => {
    return {...answerMap, [row.promptId]: getNormalizedSummaryAnswer(row)}
  }, {})
  const summaryAnswer = deriveStrictSummaryAnswer(getSummaryCriteria(summaryPromptGroup.prompts), normalizedAnswers)

  return summaryAnswer
    ? {
        ...firstRow,
        promptId: summaryPromptId,
        sourceProjectId: summaryPromptGroup.sourceProjectId,
        answeredOriginal: summaryAnswer,
        answeredOriginalAsArray: null,
      }
    : null
}

const getLatestComparisonProjectLlmRowsByPromptId = (rows: ComparisonProjectLlmRow[]) => {
  return rows.reduce<Map<string, ComparisonProjectLlmRow>>((rowMap, row) => {
    const existingRow = rowMap.get(row.promptId)

    return !existingRow || row.createdAt.getTime() >= existingRow.createdAt.getTime()
      ? rowMap.set(row.promptId, row)
      : rowMap
  }, new Map<string, ComparisonProjectLlmRow>())
}

const getComparisonProjectLlmSummaryRows = (scope: ComparisonProjectScope, rows: ComparisonProjectLlmRow[]) => {
  if (!getIsSummaryMode(scope)) {
    return rows
  }

  const summaryPromptGroups = getComparisonProjectSummaryPromptGroups(scope)

  const rowGroups = rows.reduce<Map<string, ComparisonProjectLlmRow[]>>((rowMap, row) => {
    const key = `${row.articleId}:${row.modelId}:${getComparisonProjectContentKey(row)}`
    const currentRows = rowMap.get(key) ?? []
    rowMap.set(key, [...currentRows, row])
    return rowMap
  }, new Map<string, ComparisonProjectLlmRow[]>())

  return Array.from(rowGroups.values())
    .flatMap((groupRows) => {
      return summaryPromptGroups.map((summaryPromptGroup) => {
        return getComparisonProjectLlmSummaryRow(groupRows, summaryPromptGroup)
      })
    })
    .filter(isDefined)
}

const getComparisonProjectPromptHumanRows = async (scope: ComparisonProjectScope, articleIds: string[]) => {
  const promptIds = scope.prompts.map((prompt) => {
    return prompt.id
  })

  if (articleIds.length === 0 || promptIds.length === 0 || !scope.compareWithHumans) {
    return []
  }

  const rows = await appDatabaseService.queryJson<{
    articleId: string
    promptId: string
    answer: string | null
    updatedAt: unknown
  }>(`
    SELECT
      article_id AS articleId,
      prompt_id AS promptId,
      answer AS answer,
      updated_at AS updatedAt
    FROM ${judgmentHumanTable}
    WHERE article_id IN (${getInClause(articleIds)})
      AND prompt_id IN (${getInClause(promptIds)})
      AND is_answered = TRUE
      AND ${getTrimmedTextExistsClause('answer')}
  `)

  return rows.map((row) => {
    return {...row, updatedAt: getDateValue(row.updatedAt)}
  })
}

const getComparisonProjectSummaryHumanRows = async (scope: ComparisonProjectScope, articleIds: string[]) => {
  if (articleIds.length === 0 || !scope.compareWithHumans || !scope.summarySourceProjectId) {
    return []
  }

  const rows = await appDatabaseService.queryJson<{articleId: string; answer: string | null; updatedAt: unknown}>(`
    SELECT
      article_id AS articleId,
      answer AS answer,
      updated_at AS updatedAt
    FROM ${judgmentHumanSummaryTable}
    WHERE project_id = ${getSqlLiteral(scope.summarySourceProjectId)}
      AND article_id IN (${getInClause(articleIds)})
      AND ${getTrimmedTextExistsClause('answer')}
  `)

  return rows
    .map<ComparisonProjectHumanRow | null>((row) => {
      const normalizedAnswer = normalizeSummaryAnswerValue(row.answer)

      return normalizedAnswer
        ? {
            articleId: row.articleId,
            promptId: summaryPromptId,
            answer: normalizedAnswer,
            updatedAt: getDateValue(row.updatedAt),
          }
        : null
    })
    .filter(isDefined)
}

const getComparisonProjectHumanRows = async (scope: ComparisonProjectScope, articleIds: string[]) => {
  return getIsSummaryMode(scope)
    ? getComparisonProjectSummaryHumanRows(scope, articleIds)
    : getComparisonProjectPromptHumanRows(scope, articleIds)
}

const getComparisonProjectPromptTypeOptions = (type: string | null) => {
  const matches = type?.match(/['"]([^'"]+)['"]/g) ?? []

  return matches.map((match) => {
    return match.slice(1, -1)
  })
}

const getUniqueComparisonProjectConflictResolutionOptions = (options: ComparisonProjectConflictResolutionOption[]) => {
  return Array.from(
    options
      .reduce<Map<string, ComparisonProjectConflictResolutionOption>>((optionMap, option) => {
        if (!optionMap.has(option.value)) {
          optionMap.set(option.value, option)
        }

        return optionMap
      }, new Map<string, ComparisonProjectConflictResolutionOption>())
      .values(),
  )
}

const getComparisonProjectPromptResolutionOptions = (scope: ComparisonProjectScope) => {
  return scope.prompts.map<ComparisonProjectConflictResolutionOption>((prompt) => {
    return {label: prompt.promptLabel, value: prompt.id}
  })
}

const getComparisonProjectSummaryAnswerResolutionOptions = (scope: ComparisonProjectScope) => {
  return getUniqueComparisonProjectConflictResolutionOptions(
    scope.prompts.flatMap((prompt) => {
      return getComparisonProjectPromptTypeOptions(prompt.type).map<ComparisonProjectConflictResolutionOption>(
        (option) => {
          return {label: option, value: option}
        },
      )
    }),
  )
}

const getComparisonProjectConflictResolutionOptions = (scope: ComparisonProjectScope) => {
  return getIsSummaryMode(scope)
    ? getComparisonProjectSummaryAnswerResolutionOptions(scope)
    : getComparisonProjectPromptResolutionOptions(scope)
}

const getComparisonProjectConflictResolutionOptionByValue = (scope: ComparisonProjectScope) => {
  return getComparisonProjectConflictResolutionOptions(scope).reduce<
    Map<string, ComparisonProjectConflictResolutionOption>
  >((optionMap, option) => {
    optionMap.set(option.value, option)
    return optionMap
  }, new Map<string, ComparisonProjectConflictResolutionOption>())
}

const getComparisonProjectRowsForArticles = async (scope: ComparisonProjectScope, articleIds: string[]) => {
  const uniqueArticleIds = getUniqueStringValues(articleIds)

  if (uniqueArticleIds.length === 0) {
    return []
  }

  const articleScopeConditions = getArticleScopeConditions(
    scope.importRouteIds,
    scope.sourceProjectIds,
    scope.useImportRoutesForScope,
  )
  const articleScopeWhereClause = getWhereClause([
    ...articleScopeConditions,
    `a.id IN (${getInClause(uniqueArticleIds)})`,
  ])
  const articles = await getComparisonProjectScopedArticleBatch({
    articleTable,
    limit: uniqueArticleIds.length,
    offset: 0,
    queryRunner: appDatabaseService,
    whereClause: articleScopeWhereClause,
  })
  const [rawLlmRows, humanRows] = await Promise.all([
    getComparisonProjectLlmRows(scope, uniqueArticleIds),
    getComparisonProjectHumanRows(scope, uniqueArticleIds),
  ])

  return getComparisonProjectBatchRows({
    articles,
    columns: scope.columns,
    differenceFilter: 'all',
    humanRows,
    isSummaryMode: getIsSummaryMode(scope),
    llmRows: getComparisonProjectLlmSummaryRows(scope, rawLlmRows),
    requiredHumanColumnIds: getComparisonProjectRequiredColumnIds(scope.columns, 'human'),
    requiredLlmColumnIds: getComparisonProjectRequiredColumnIds(scope.columns, 'llm'),
    rowFilter: 'all',
  })
}

const getComparisonProjectConflictResolutions = async (
  scope: ComparisonProjectScope,
  rows: ComparisonProjectJudgmentRow[],
) => {
  const articleIds = rows
    .filter((row) => {
      return row.hasConflict
    })
    .map((row) => {
      return row.canonicalArticleId
    })

  if (!scope.allowConflictResolution || articleIds.length === 0) {
    return new Map<string, ComparisonProjectConflictResolution>()
  }

  const optionByValue = getComparisonProjectConflictResolutionOptionByValue(scope)
  const resolutionRows = await appDatabaseService.queryJson<{
    answerValue: string | null
    articleId: string
    promptId: string | null
  }>(`
    SELECT
      article_id AS articleId,
      prompt_id AS promptId,
      answer_value AS answerValue
    FROM ${comparisonProjectConflictResolutionTable}
    WHERE comparison_project_id = ${getSqlLiteral(scope.id)}
      AND article_id IN (${getInClause(articleIds)})
  `)

  return resolutionRows.reduce<Map<string, ComparisonProjectConflictResolution>>((resolutionMap, row) => {
    const value = getIsSummaryMode(scope) ? row.answerValue : row.promptId
    const option = value ? optionByValue.get(value) : null

    if (!option) {
      return resolutionMap
    }

    resolutionMap.set(row.articleId, {articleId: row.articleId, label: option.label, value: option.value})
    return resolutionMap
  }, new Map<string, ComparisonProjectConflictResolution>())
}

const getComparisonProjectRowsWithConflictResolutions = async (
  scope: ComparisonProjectScope,
  rows: ComparisonProjectJudgmentRow[],
) => {
  const conflictResolutions = await getComparisonProjectConflictResolutions(scope, rows)

  return rows.map((row) => {
    return {
      ...row,
      conflictResolution: row.hasConflict ? (conflictResolutions.get(row.canonicalArticleId) ?? null) : null,
    }
  })
}

const getComparisonProjectConflictResolutionTargetRow = async (scope: ComparisonProjectScope, articleId: string) => {
  if (!scope.allowConflictResolution) {
    throw new HttpError(400, 'Conflict resolution is not enabled for this comparison project')
  }

  const [row] = await getComparisonProjectRowsForArticles(scope, [articleId])

  if (!row?.hasConflict) {
    throw new HttpError(400, 'Conflict resolution is only available for conflicting articles')
  }

  return row
}

const getValidatedComparisonProjectConflictResolutionOption = (scope: ComparisonProjectScope, value: string) => {
  const option = getComparisonProjectConflictResolutionOptionByValue(scope).get(value)

  if (!option) {
    throw new HttpError(
      400,
      getIsSummaryMode(scope)
        ? 'Conflict resolution answer must be one of the summary prompt options'
        : 'Conflict resolution prompt must belong to the comparison project',
    )
  }

  return option
}

const setComparisonProjectConflictResolution = async (params: {
  articleId: string
  value: string
  scope: ComparisonProjectScope
}) => {
  await getComparisonProjectConflictResolutionTargetRow(params.scope, params.articleId)
  const option = getValidatedComparisonProjectConflictResolutionOption(params.scope, params.value)
  const isSummaryMode = getIsSummaryMode(params.scope)
  const [resolutionRow] = await appDatabaseService.queryJson<{articleId: string}>(`
    INSERT INTO ${comparisonProjectConflictResolutionTable} (
      id,
      comparison_project_id,
      article_id,
      prompt_id,
      answer_value
    )
    VALUES (
      ${getSqlLiteral(crypto.randomUUID())},
      ${getSqlLiteral(params.scope.id)},
      ${getSqlLiteral(params.articleId)},
      ${getSqlLiteral(isSummaryMode ? null : option.value)},
      ${getSqlLiteral(isSummaryMode ? option.value : null)}
    )
    ON CONFLICT(comparison_project_id, article_id) DO UPDATE SET
      prompt_id = excluded.prompt_id,
      answer_value = excluded.answer_value,
      updated_at = now()
    RETURNING article_id AS articleId
  `)

  if (!resolutionRow) {
    throw new Error('Failed to save conflict resolution')
  }

  return {...resolutionRow, label: option.label, value: option.value}
}

const resetComparisonProjectConflictResolution = async (params: {articleId: string; scope: ComparisonProjectScope}) => {
  await appDatabaseService.run(`
    DELETE FROM ${comparisonProjectConflictResolutionTable}
    WHERE comparison_project_id = ${getSqlLiteral(params.scope.id)}
      AND article_id = ${getSqlLiteral(params.articleId)}
  `)

  return {articleId: params.articleId}
}

const escapeComparisonProjectCsvValue = (value: string) => {
  return value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')
    ? `"${value.replace(/"/g, '""')}"`
    : value
}

const getComparisonProjectCsvLine = (values: string[]) => {
  return `${values.map(escapeComparisonProjectCsvValue).join(',')}\n`
}

const getComparisonProjectExportDateValue = (value: Date | string | null) => {
  return value ? new Date(value).toISOString() : ''
}

const getComparisonProjectExportCellValue = (value: string | null | undefined) => {
  return (value ?? '')
    .split(/\r\n|\n|\r/g)
    .map((line) => {
      return line.trim()
    })
    .filter((line) => {
      return line !== ''
    })
    .join('; ')
}

const getComparisonProjectExportColumnHeader = (column: ComparisonProjectJudgmentsColumn) => {
  return [column.sourceProjectName, column.promptLabel, column.modelLabel, column.contentLabel]
    .map((part) => {
      return part?.trim() ?? ''
    })
    .filter((part) => {
      return part !== ''
    })
    .join(' - ')
}

const getComparisonProjectExportHeaders = (
  columns: readonly ComparisonProjectJudgmentsColumn[],
  includeConflictResolution: boolean,
) => {
  return [
    'Title',
    'Abstract/Summary',
    'Date added',
    ...(includeConflictResolution ? ['Conflict Handling'] : []),
    ...columns.map((column) => {
      return getComparisonProjectExportColumnHeader(column)
    }),
  ]
}

const getComparisonProjectExportConflictResolutionValue = (row: ComparisonProjectExportRow) => {
  return row.conflictResolution?.label ?? (row.hasConflict ? '' : 'No conflict')
}

const getComparisonProjectExportRowValues = (
  row: ComparisonProjectExportRow,
  columns: readonly ComparisonProjectJudgmentsColumn[],
  includeConflictResolution: boolean,
) => {
  return [
    row.articleTitle?.trim() || 'Untitled',
    row.articleSummary ?? '',
    getComparisonProjectExportDateValue(row.articleCreatedAt),
    ...(includeConflictResolution ? [getComparisonProjectExportConflictResolutionValue(row)] : []),
    ...columns.map((column) => {
      return getComparisonProjectExportCellValue(row.cells[column.id])
    }),
  ]
}

const enqueueComparisonProjectExportRows = (
  controller: ReadableStreamDefaultController<string>,
  rows: ComparisonProjectExportRow[],
  columns: readonly ComparisonProjectJudgmentsColumn[],
  includeConflictResolution: boolean,
) => {
  rows.reduce((count, row) => {
    controller.enqueue(
      getComparisonProjectCsvLine(getComparisonProjectExportRowValues(row, columns, includeConflictResolution)),
    )
    return count + 1
  }, 0)
}

const getComparisonProjectExportFilename = (scope: ComparisonProjectScope) => {
  return `${scope.name.replace(/[^a-zA-Z0-9]/g, '_')}_comparison_export_${new Date().toISOString().slice(0, 10)}.csv`
}

const getComparisonProjectExportResponse = (
  scope: ComparisonProjectScope,
  rowFilter: ComparisonProjectRowFilter,
  differenceFilter: ComparisonProjectDifferenceFilter,
) => {
  const orderedColumns = getOrderedComparisonProjectColumns(scope.columns, scope.prompts)
  const normalizedDifferenceFilter = getNormalizedComparisonProjectDifferenceFilter(differenceFilter, orderedColumns)
  const includeConflictResolution = scope.allowConflictResolution
  const headers = getComparisonProjectExportHeaders(orderedColumns, includeConflictResolution)
  const filename = getComparisonProjectExportFilename(scope)
  const responseHeaders = {
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Type': 'text/csv; charset=utf-8',
  }
  const stream = new ReadableStream<string>({
    async start(controller) {
      try {
        controller.enqueue(getComparisonProjectCsvLine(headers))

        if (scope.prompts.length > 0 && orderedColumns.length > 0) {
          await forEachComparisonProjectServingJudgmentRowBatch({
            comparisonProjectId: scope.id,
            differenceFilter: normalizedDifferenceFilter,
            limit: comparisonProjectJudgmentArticleBatchSize,
            onRows: async (rows) => {
              const exportRows = includeConflictResolution
                ? await getComparisonProjectRowsWithConflictResolutions(scope, rows)
                : rows
              enqueueComparisonProjectExportRows(controller, exportRows, orderedColumns, includeConflictResolution)
            },
            queryRunner: appDatabaseService,
            rowFilter,
          })
        }

        controller.close()
      } catch (error) {
        controller.error(error)
      }
    },
  })

  return new Response(stream, {headers: responseHeaders})
}

const getComparisonProjectJudgmentsPage = async (
  scope: ComparisonProjectScope,
  page: number,
  limit: number,
  cursor: string | null,
  rowFilter: ComparisonProjectRowFilter,
  differenceFilter: ComparisonProjectDifferenceFilter,
) => {
  if (scope.prompts.length === 0 || scope.columns.length === 0) {
    return {
      activeGeneration: scope.activeGeneration,
      data: [],
      isServingReady: scope.isServingReady,
      limit,
      nextCursor: null,
      page: 1,
      servingStatus: scope.servingStatus,
      servingUpdatedAt: scope.servingUpdatedAt,
      totalCount: null,
      totalPages: null,
    }
  }

  if (scope.activeGeneration === null) {
    return {
      activeGeneration: scope.activeGeneration,
      data: [],
      isServingReady: scope.isServingReady,
      limit,
      nextCursor: null,
      page: 1,
      servingStatus: scope.servingStatus,
      servingUpdatedAt: scope.servingUpdatedAt,
      totalCount: null,
      totalPages: null,
    }
  }

  const normalizedDifferenceFilter = getNormalizedComparisonProjectDifferenceFilter(differenceFilter, scope.columns)
  const pageResult = await getComparisonProjectServingJudgmentRowsPage({
    comparisonProjectId: scope.id,
    cursor,
    differenceFilter: normalizedDifferenceFilter,
    limit,
    queryRunner: appDatabaseService,
    rowFilter,
  })
  const rowsWithConflictResolutions = await getComparisonProjectRowsWithConflictResolutions(scope, pageResult.rows)

  return {
    activeGeneration: scope.activeGeneration,
    data: rowsWithConflictResolutions,
    isServingReady: scope.isServingReady,
    limit,
    nextCursor: pageResult.nextCursor,
    page,
    servingStatus: scope.servingStatus,
    servingUpdatedAt: scope.servingUpdatedAt,
    totalCount: null,
    totalPages: null,
  }
}

const getComparisonProjectJudgmentsCount = async (
  scope: ComparisonProjectScope,
  limit: number,
  rowFilter: ComparisonProjectRowFilter,
  differenceFilter: ComparisonProjectDifferenceFilter,
) => {
  if (scope.prompts.length === 0 || scope.columns.length === 0) {
    return {
      activeGeneration: scope.activeGeneration,
      isServingReady: scope.isServingReady,
      limit,
      servingStatus: scope.servingStatus,
      servingUpdatedAt: scope.servingUpdatedAt,
      totalCount: 0,
      totalPages: 0,
    }
  }

  const normalizedDifferenceFilter = getNormalizedComparisonProjectDifferenceFilter(differenceFilter, scope.columns)
  const countResult = await getComparisonProjectServingJudgmentCount({
    comparisonProjectId: scope.id,
    differenceFilter: normalizedDifferenceFilter,
    limit,
    queryRunner: appDatabaseService,
    rowFilter,
  })

  return {
    activeGeneration: scope.activeGeneration,
    isServingReady: scope.isServingReady,
    limit,
    servingStatus: scope.servingStatus,
    servingUpdatedAt: scope.servingUpdatedAt,
    totalCount: countResult.totalCount,
    totalPages: countResult.totalPages,
  }
}

const getComparisonProjectStatsResponse = async (
  scope: ComparisonProjectScope,
): Promise<ComparisonProjectStatsResponse> => {
  const statsParams = {
    allowConflictResolution: scope.allowConflictResolution,
    columns: scope.columns,
    comparisonProjectId: scope.id,
    generation: scope.activeGeneration,
    isSummaryMode: getIsSummaryMode(scope),
    primaryModelId: scope.modelIds?.[0] ?? null,
    primarySourceProjectId: scope.summarySourceProjectId ?? scope.sourceProjectIds[0] ?? null,
    queryRunner: appDatabaseService,
  }
  const comparisons = await getComparisonProjectStats(statsParams)
  const additionalProjectStats = await getComparisonProjectAdditionalStats(statsParams)

  return {
    activeGeneration: scope.activeGeneration,
    additionalProjectStats,
    comparisons,
    isServingReady: scope.isServingReady,
    servingStatus: scope.servingStatus,
    servingUpdatedAt: scope.servingUpdatedAt,
  }
}

const insertComparisonProjectPromptLinks = async (
  tx: AppTx,
  comparisonProjectId: string,
  promptSelections: PromptSelection[],
) => {
  const promptIds = promptSelections.map((selection) => {
    return selection.promptId
  })

  if (promptIds.length === 0) {
    return
  }

  const promptRows = await tx.queryJson<{id: string}>(`
    SELECT id
    FROM ${promptTable}
    WHERE id IN (${getInClause(promptIds)})
  `)

  if (promptRows.length !== promptIds.length) {
    throw new Error('One or more selected prompts are invalid')
  }

  const [currentPromptSelection] = promptSelections

  if (!currentPromptSelection) {
    return
  }

  await tx.run(`
    INSERT INTO ${comparisonProjectPromptTable} (
      id,
      comparison_project_id,
      prompt_id,
      prompt_order,
      criteria_disposition,
      criteria_section_key,
      criteria_section_label
    )
    VALUES (
      ${getSqlLiteral(crypto.randomUUID())},
      ${getSqlLiteral(comparisonProjectId)},
      ${getSqlLiteral(currentPromptSelection.promptId)},
      ${currentPromptSelection.order},
      ${getSqlLiteral(currentPromptSelection.criteriaDisposition ?? null)},
      ${getSqlLiteral(currentPromptSelection.criteriaSectionKey ?? null)},
      ${getSqlLiteral(currentPromptSelection.criteriaSectionLabel ?? null)}
    )
  `)

  return insertComparisonProjectPromptLinks(tx, comparisonProjectId, promptSelections.slice(1))
}

const insertComparisonProjectRouteLinks = async (tx: AppTx, comparisonProjectId: string, importRoutes: string[]) => {
  if (importRoutes.length === 0) {
    return
  }

  const routeRows = await tx.queryJson<{id: string; route: string}>(`
    SELECT id, route
    FROM ${importRouteTable}
    WHERE route IN (${getInClause(importRoutes)})
  `)

  if (routeRows.length !== importRoutes.length) {
    throw new Error('One or more selected import routes are invalid')
  }

  const [currentRouteRow] = routeRows

  if (!currentRouteRow) {
    return
  }

  await tx.run(`
    INSERT INTO ${comparisonProjectImportRouteTable} (id, comparison_project_id, import_route_id)
    VALUES (
      ${getSqlLiteral(crypto.randomUUID())},
      ${getSqlLiteral(comparisonProjectId)},
      ${getSqlLiteral(currentRouteRow.id)}
    )
  `)

  return insertComparisonProjectRouteLinks(
    tx,
    comparisonProjectId,
    routeRows.slice(1).map((routeRow) => {
      return routeRow.route
    }),
  )
}

const insertComparisonProjectSourceProjectLinks = async (
  tx: AppTx,
  comparisonProjectId: string,
  sourceProjectIds: string[],
) => {
  const [currentSourceProjectId] = sourceProjectIds

  if (!currentSourceProjectId) {
    return
  }

  await tx.run(`
    INSERT INTO ${comparisonProjectSourceProjectTable} (id, comparison_project_id, source_project_id)
    VALUES (
      ${getSqlLiteral(crypto.randomUUID())},
      ${getSqlLiteral(comparisonProjectId)},
      ${getSqlLiteral(currentSourceProjectId)}
    )
  `)

  return insertComparisonProjectSourceProjectLinks(tx, comparisonProjectId, sourceProjectIds.slice(1))
}

const deleteComparisonProjectLinkRows = async (tx: AppTx, tableName: string, comparisonProjectId: string) => {
  await tx.run(`
    DELETE FROM ${tableName}
    WHERE comparison_project_id = ${getSqlLiteral(comparisonProjectId)}
  `)
}

const getValidatedModelIds = async (db: AppQueryRunner, modelIds: string[]) => {
  if (modelIds.length === 0) {
    return null
  }

  return assertSelectableProviderModelIds(db, {
    errorMessage: 'One or more selected models do not exist or are disabled',
    modelIds,
  })
}

const getValidatedPromptSelections = async (db: AppQueryRunner, promptSelections: PromptSelection[]) => {
  const uniquePromptSelections = getUniquePromptSelections(promptSelections)

  if (uniquePromptSelections.length === 0) {
    return uniquePromptSelections
  }

  const promptRows = await db.queryJson<{id: string}>(`
    SELECT id
    FROM ${promptTable}
    WHERE id IN (${getInClause(
      uniquePromptSelections.map((promptSelection) => {
        return promptSelection.promptId
      }),
    )})
  `)

  if (promptRows.length !== uniquePromptSelections.length) {
    throw new Error('One or more selected prompts are invalid')
  }

  return uniquePromptSelections
}

const getSummarySourceProjectId = (summarySourceProjectId?: string | null) => {
  const trimmedSummarySourceProjectId = summarySourceProjectId?.trim() ?? ''

  if (!trimmedSummarySourceProjectId) {
    throw new Error('Summary mode requires a summary source project')
  }

  return trimmedSummarySourceProjectId
}

const validateSummaryModeSourceProject = async (db: AppQueryRunner, summarySourceProjectId: string) => {
  const [summarySourceProject] = await db.queryJson<{id: string; humanJudgmentMode: HumanJudgmentMode | null}>(`
    SELECT id, human_judgment_mode AS humanJudgmentMode
    FROM ${projectTable}
    WHERE id = ${getSqlLiteral(summarySourceProjectId)}
      AND archived = FALSE
    LIMIT 1
  `)

  if (!summarySourceProject || summarySourceProject.humanJudgmentMode !== 'summary') {
    throw new Error('Summary source project must exist and be summary-capable')
  }
}

const getValidatedSummaryPromptSelections = async (
  db: AppQueryRunner,
  summarySourceProjectId: string,
  promptSelections: PromptSelection[],
) => {
  const uniquePromptSelections = getUniquePromptSelections(promptSelections)
  const selectedPromptIds = uniquePromptSelections.map((promptSelection) => {
    return promptSelection.promptId
  })

  const sourcePromptRows = await db.queryJson<{
    promptId: string
    order: number | null
    criteriaDisposition: ProjectPromptCriteriaDisposition | null
    criteriaSectionKey: string | null
    criteriaSectionLabel: string | null
  }>(`
    SELECT
      prompt_id AS promptId,
      prompt_order AS order,
      criteria_disposition AS criteriaDisposition,
      criteria_section_key AS criteriaSectionKey,
      criteria_section_label AS criteriaSectionLabel
    FROM ${projectPromptTable}
    WHERE project_id = ${getSqlLiteral(summarySourceProjectId)}
      AND enabled = TRUE
      AND criteria_disposition IS NOT NULL
      AND criteria_section_key IS NOT NULL
      ${selectedPromptIds.length > 0 ? `AND prompt_id IN (${getInClause(selectedPromptIds)})` : ''}
    ORDER BY prompt_order ASC, prompt_id ASC
  `)

  if (uniquePromptSelections.length === 0) {
    if (sourcePromptRows.length === 0) {
      throw new Error('Selected summary source project has no prompts with summary criteria metadata')
    }

    return sourcePromptRows.map<PromptSelection>((sourcePromptRow, index) => {
      return {
        promptId: sourcePromptRow.promptId,
        order: sourcePromptRow.order ?? index,
        criteriaDisposition: sourcePromptRow.criteriaDisposition,
        criteriaSectionKey: sourcePromptRow.criteriaSectionKey,
        criteriaSectionLabel: sourcePromptRow.criteriaSectionLabel,
      }
    })
  }

  const sourcePromptRowsByPromptId = sourcePromptRows.reduce<Map<string, (typeof sourcePromptRows)[number]>>(
    (rowMap, sourcePromptRow) => {
      rowMap.set(sourcePromptRow.promptId, sourcePromptRow)
      return rowMap
    },
    new Map<string, (typeof sourcePromptRows)[number]>(),
  )

  if (sourcePromptRowsByPromptId.size !== uniquePromptSelections.length) {
    throw new Error(
      'Summary mode selected prompts must exist on the summary source project and include summary criteria metadata',
    )
  }

  return uniquePromptSelections.map<PromptSelection>((promptSelection) => {
    const sourcePromptRow = sourcePromptRowsByPromptId.get(promptSelection.promptId)

    if (!sourcePromptRow) {
      throw new Error(
        'Summary mode selected prompts must exist on the summary source project and include summary criteria metadata',
      )
    }

    return {
      promptId: promptSelection.promptId,
      order: promptSelection.order,
      criteriaDisposition: sourcePromptRow.criteriaDisposition,
      criteriaSectionKey: sourcePromptRow.criteriaSectionKey,
      criteriaSectionLabel: sourcePromptRow.criteriaSectionLabel,
    }
  })
}

const getValidatedComparisonPromptSelections = async (
  db: AppQueryRunner,
  params: {
    compareWithHumans: boolean
    humanJudgmentMode: HumanJudgmentMode
    promptSelections: PromptSelection[]
    summarySourceProjectId: string | null
  },
) => {
  if (params.humanJudgmentMode !== 'summary') {
    return getValidatedPromptSelections(db, params.promptSelections)
  }

  if (!params.compareWithHumans) {
    throw new Error('Summary mode requires compareWithHumans to be true')
  }

  const summarySourceProjectId = getSummarySourceProjectId(params.summarySourceProjectId)
  await validateSummaryModeSourceProject(db, summarySourceProjectId)

  return getValidatedSummaryPromptSelections(db, summarySourceProjectId, params.promptSelections)
}

const hasSameStringArrayValue = (left: string[] | null, right: string[] | null) => {
  return JSON.stringify(left ?? []) === JSON.stringify(right ?? [])
}

const getDuckdbStringArrayValue = (value: unknown) => {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => {
      return typeof entry === 'string'
    })
  }

  if (typeof value !== 'string') {
    return null
  }

  const trimmedValue = value.trim()

  if (trimmedValue === '[]') {
    return []
  }

  if (!trimmedValue.startsWith('[') || !trimmedValue.endsWith(']')) {
    return null
  }

  return trimmedValue
    .slice(1, -1)
    .split(',')
    .map((part) => {
      return part.trim()
    })
    .filter((part) => {
      return part !== ''
    })
}

const updateComparisonProjectWithRelinkedLinks = async (params: {
  comparisonProjectId: string
  importRoutes?: string[]
  setParts: string[]
  sourceProjectIds?: string[]
  promptSelections: PromptSelection[]
}): Promise<ComparisonProjectRecordRow | null> => {
  return appDatabaseService.transaction(async (tx) => {
    const updatedComparisonProjectRecord = await updateComparisonProjectTx(tx, {
      comparisonProjectId: params.comparisonProjectId,
      setParts: params.setParts,
    })

    if (!updatedComparisonProjectRecord) {
      throw new Error('Comparison project not found')
    }

    await deleteComparisonProjectLinkRows(tx, comparisonProjectPromptTable, params.comparisonProjectId)
    await insertComparisonProjectPromptLinks(tx, params.comparisonProjectId, params.promptSelections)

    if (params.importRoutes !== undefined) {
      await deleteComparisonProjectLinkRows(tx, comparisonProjectImportRouteTable, params.comparisonProjectId)
      await insertComparisonProjectRouteLinks(tx, params.comparisonProjectId, params.importRoutes)
    }

    if (params.sourceProjectIds !== undefined) {
      await deleteComparisonProjectLinkRows(tx, comparisonProjectSourceProjectTable, params.comparisonProjectId)
      await insertComparisonProjectSourceProjectLinks(tx, params.comparisonProjectId, params.sourceProjectIds)
    }

    return updatedComparisonProjectRecord
  }) as Promise<ComparisonProjectRecordRow | null>
}

const createComparisonProjectRecord = async (
  tx: AppTx,
  body: {
    name: string
    description?: string | null
    modelIds?: string[]
    compareWithHumans?: boolean
    allowConflictResolution?: boolean
    humanJudgmentMode?: HumanJudgmentMode
    summarySourceProjectId?: string | null
    useTitle?: boolean
    useAbstract?: boolean
    useFulltext?: boolean
    useFulltextNoImages?: boolean
    importRoutes?: string[]
    sourceProjectIds?: string[]
    promptSelections?: PromptSelection[]
  },
): Promise<ReturnType<typeof getComparisonProjectRecordValue>> => {
  const useTitle = body.useTitle ?? true
  const useAbstract = body.useAbstract ?? true
  const useFulltext = body.useFulltext ?? false
  const useFulltextNoImages = body.useFulltextNoImages ?? false

  if (!useTitle && !useAbstract && !useFulltext && !useFulltextNoImages) {
    throw new Error('Select at least one article content option to compare')
  }

  const validatedModelIds = await getValidatedModelIds(tx, getUniqueStringValues(body.modelIds ?? []))
  const humanJudgmentMode = body.humanJudgmentMode ?? 'prompt'
  const summarySourceProjectId =
    humanJudgmentMode === 'summary' ? getSummarySourceProjectId(body.summarySourceProjectId) : null
  const validatedPromptSelections = await getValidatedComparisonPromptSelections(tx, {
    compareWithHumans: body.compareWithHumans ?? false,
    humanJudgmentMode,
    promptSelections: body.promptSelections ?? [],
    summarySourceProjectId,
  })
  const uniqueImportRoutes = getUniqueStringValues(body.importRoutes ?? [])
  const validatedSourceProjectIds = await getValidatedComparisonSourceProjectIds(tx, body.sourceProjectIds ?? [])
  const [newComparisonProject] = await tx.queryJson<{
    id: string
    name: string
    description: string | null
    modelIds: unknown
    compareWithHumans: boolean
    allowConflictResolution: boolean
    humanJudgmentMode: HumanJudgmentMode | null
    summarySourceProjectId: string | null
    useTitle: boolean
    useAbstract: boolean
    useFulltext: boolean
    useFulltextNoImages: boolean
    archived: boolean
    createdAt: unknown
    updatedAt: unknown
  }>(`
    INSERT INTO ${comparisonProjectTable} (
      id,
      name,
      description,
      model_ids,
      compare_with_humans,
      allow_conflict_resolution,
      human_judgment_mode,
      summary_source_project_id,
      use_title,
      use_abstract,
      use_fulltext,
      use_fulltext_no_images
    )
    VALUES (
      ${getSqlLiteral(crypto.randomUUID())},
      ${getSqlLiteral(body.name)},
      ${getSqlLiteral(body.description?.trim() || null)},
      ${getSqlLiteral(validatedModelIds)},
      ${getBooleanLiteral(body.compareWithHumans ?? false)},
      ${getBooleanLiteral(body.allowConflictResolution ?? false)},
      ${getSqlLiteral(humanJudgmentMode)},
      ${getSqlLiteral(summarySourceProjectId)},
      ${getBooleanLiteral(useTitle)},
      ${getBooleanLiteral(useAbstract)},
      ${getBooleanLiteral(useFulltext)},
      ${getBooleanLiteral(useFulltextNoImages)}
    )
    RETURNING
      id,
      name,
      description,
      model_ids AS modelIds,
      compare_with_humans AS compareWithHumans,
      allow_conflict_resolution AS allowConflictResolution,
      human_judgment_mode AS humanJudgmentMode,
      summary_source_project_id AS summarySourceProjectId,
      use_title AS useTitle,
      use_abstract AS useAbstract,
      use_fulltext AS useFulltext,
      use_fulltext_no_images AS useFulltextNoImages,
      archived,
      created_at AS createdAt,
      updated_at AS updatedAt
  `)

  if (!newComparisonProject) {
    throw new Error('Failed to create comparison project')
  }

  await insertComparisonProjectPromptLinks(tx, newComparisonProject.id, validatedPromptSelections)
  await insertComparisonProjectRouteLinks(tx, newComparisonProject.id, uniqueImportRoutes)
  await insertComparisonProjectSourceProjectLinks(tx, newComparisonProject.id, validatedSourceProjectIds)

  return getComparisonProjectRecordValue(newComparisonProject)
}

export const comparisonProjectsRoutes = new Elysia()
  .use(withErrorHandler())
  .get('/api/comparison-projects', async () => {
    const data = await getComparisonProjectsList(false)

    return {data}
  })
  .get('/api/comparison-projects/archived', async () => {
    const data = await getComparisonProjectsList(true)

    return {data}
  })
  .get('/api/comparison-projects/sources', async () => {
    const data = await getComparisonProjectSources()

    return {data}
  })
  .get('/api/comparison-projects/conflict-resolution-import-sources', async () => {
    const data = await getComparisonProjectConflictResolutionImportSources()

    return {data}
  })
  .post(
    '/api/comparison-projects/from-project',
    async (context) => {
      const {body} = context
      const sources = await getComparisonProjectSources()
      const selectedSourceProjectIds = getUniqueStringValues([body.sourceProjectId, ...(body.sourceProjectIds ?? [])])
      const selectedSourceProjects = getSelectedComparisonProjectSources(sources, selectedSourceProjectIds)
      const sourceProject = selectedSourceProjects.find((source) => {
        return source.id === body.sourceProjectId
      })

      if (!sourceProject) {
        throw new Error('Source project not found')
      }

      const humanJudgmentMode =
        body.humanJudgmentMode ?? (sourceProject.isSummaryCapable && body.compareWithHumans ? 'summary' : 'prompt')
      const summarySourceProjectId =
        humanJudgmentMode === 'summary' ? (body.summarySourceProjectId ?? sourceProject.id) : null
      const sourcePromptSelections =
        humanJudgmentMode === 'summary' && summarySourceProjectId
          ? getValidatedCreateFromProjectSummarySelections({selectedSourceProjects, summarySourceProjectId})
          : sourceProject.prompts.map<PromptSelection>((prompt) => {
              return {
                promptId: prompt.id,
                order: prompt.order,
                criteriaDisposition: prompt.criteriaDisposition,
                criteriaSectionKey: prompt.criteriaSectionKey,
                criteriaSectionLabel: prompt.criteriaSectionLabel,
              }
            })

      if (humanJudgmentMode !== 'summary' && selectedSourceProjectIds.length > 1) {
        throw new Error('Additional source projects require summary mode')
      }

      const selectedModelIds = getUniqueStringValues(
        (humanJudgmentMode === 'summary' ? selectedSourceProjects : [sourceProject]).map((selectedSourceProject) => {
          return selectedSourceProject.modelId
        }),
      )
      const selectedImportRoutes = getUniqueStringValues(
        (humanJudgmentMode === 'summary' ? selectedSourceProjects : [sourceProject]).flatMap(
          (selectedSourceProject) => {
            return selectedSourceProject.importRoutes.map((importRoute) => {
              return importRoute.route
            })
          },
        ),
      )
      const createdComparisonProject = (await appDatabaseService.transaction(async (tx) => {
        return createComparisonProjectRecord(tx, {
          name: body.name,
          description: body.description,
          modelIds: selectedModelIds,
          compareWithHumans: body.compareWithHumans,
          allowConflictResolution: body.allowConflictResolution,
          humanJudgmentMode,
          summarySourceProjectId,
          useTitle: sourceProject.useTitle,
          useAbstract: sourceProject.useAbstract,
          useFulltext: sourceProject.useFulltext,
          useFulltextNoImages: sourceProject.useFulltextNoImages,
          importRoutes: selectedImportRoutes,
          sourceProjectIds: humanJudgmentMode === 'summary' ? selectedSourceProjectIds : [sourceProject.id],
          promptSelections: sourcePromptSelections,
        })
      })) as Awaited<ReturnType<typeof createComparisonProjectRecord>>
      await markComparisonProjectServingStaleAndQueueRebuild(createdComparisonProject.id)

      return {data: createdComparisonProject}
    },
    {
      body: t.Object({
        name: t.String(),
        description: t.Optional(t.Union([t.String(), t.Null()])),
        compareWithHumans: t.Optional(t.Boolean()),
        allowConflictResolution: t.Optional(t.Boolean()),
        humanJudgmentMode: t.Optional(t.Union([t.Literal('prompt'), t.Literal('summary')])),
        summarySourceProjectId: t.Optional(t.Union([t.String(), t.Null()])),
        sourceProjectId: t.String(),
        sourceProjectIds: t.Optional(t.Array(t.String())),
      }),
    },
  )
  .get('/api/comparison-projects/:id/edit', async (context) => {
    const {params, set} = context
    const data = await getComparisonProjectEditFormData(params.id)

    if (!data) {
      set.status = 404
      return {data: null, error: 'Comparison project not found'}
    }

    return {data}
  })
  .get('/api/comparison-projects/:id/stats', async (context) => {
    const {params, set} = context
    const scope = await getComparisonProjectScope(params.id)

    if (!scope) {
      set.status = 404
      return {data: null, error: 'Comparison project not found'}
    }

    const data = await getComparisonProjectStatsResponse(scope)

    return {data}
  })
  .get('/api/comparison-projects/:id', async (context) => {
    const {params, set} = context
    const data = await getComparisonProjectScope(params.id)

    if (!data) {
      set.status = 404
      return {data: null, error: 'Comparison project not found'}
    }

    queueUnavailableComparisonProjectServingRebuild(data)

    return {data}
  })
  .post(
    '/api/comparison-projects/:id/judgments',
    async (context) => {
      const {params, body, set} = context
      const data = await getComparisonProjectScope(params.id)

      if (!data) {
        set.status = 404
        return {data: null, error: 'Comparison project not found'}
      }

      const parsedPage = getRequestedPositiveInteger(body.page, 1)
      const parsedLimit = getRequestedPositiveInteger(body.limit, 50)
      const page = Math.max(parsedPage, 1)
      const limit = Math.min(Math.max(parsedLimit, 1), 100)
      const cursor = getComparisonProjectJudgmentsCursor({cursor: body.cursor, limit, page})
      const differenceFilter = getRequestedComparisonProjectDifferenceFilter({
        differenceFilter: body.differenceFilter,
        showOnlyModelDifferences: body.showOnlyModelDifferences,
      })
      const rowFilter = getNormalizedComparisonProjectRowFilter(body.rowFilter)
      const judgmentsPage = await getComparisonProjectJudgmentsPage(
        data,
        page,
        limit,
        cursor,
        rowFilter,
        differenceFilter,
      )

      return {data: judgmentsPage}
    },
    {
      body: t.Object({
        page: t.Optional(t.Union([t.String(), t.Number()])),
        limit: t.Union([t.String(), t.Number()]),
        cursor: t.Optional(t.Nullable(t.String())),
        rowFilter: t.Optional(t.String()),
        differenceFilter: t.Optional(
          t.Union([
            t.Literal('all'),
            t.Literal('human-vs-llm'),
            t.Literal('human-vs-llm-true-conflict'),
            t.Literal('llm-vs-llm'),
            t.Literal('any-disagreement'),
          ]),
        ),
        showOnlyModelDifferences: t.Optional(t.Boolean()),
      }),
    },
  )
  .post(
    '/api/comparison-projects/:id/judgments/count',
    async (context) => {
      const {params, body, set} = context
      const data = await getComparisonProjectScope(params.id)

      if (!data) {
        set.status = 404
        return {data: null, error: 'Comparison project not found'}
      }

      const parsedLimit = getRequestedPositiveInteger(body.limit, 50)
      const limit = Math.min(Math.max(parsedLimit, 1), 100)
      const differenceFilter = getRequestedComparisonProjectDifferenceFilter({differenceFilter: body.differenceFilter})
      const rowFilter = getNormalizedComparisonProjectRowFilter(body.rowFilter)
      const countResult = await getComparisonProjectJudgmentsCount(data, limit, rowFilter, differenceFilter)

      return {data: countResult}
    },
    {
      body: t.Object({
        limit: t.Union([t.String(), t.Number()]),
        rowFilter: t.Optional(t.String()),
        differenceFilter: t.Optional(
          t.Union([
            t.Literal('all'),
            t.Literal('human-vs-llm'),
            t.Literal('human-vs-llm-true-conflict'),
            t.Literal('llm-vs-llm'),
            t.Literal('any-disagreement'),
          ]),
        ),
      }),
    },
  )
  .post(
    '/api/comparison-projects/:id/conflict-resolution',
    async (context) => {
      const {params, body, set} = context
      const scope = await getComparisonProjectScope(params.id)

      if (!scope) {
        set.status = 404
        return {data: null, error: 'Comparison project not found'}
      }

      const data = await setComparisonProjectConflictResolution({articleId: body.articleId, value: body.value, scope})

      return {data}
    },
    {body: t.Object({articleId: t.String(), value: t.String()})},
  )
  .post(
    '/api/comparison-projects/:id/conflict-resolution/reset',
    async (context) => {
      const {params, body, set} = context
      const scope = await getComparisonProjectScope(params.id)

      if (!scope) {
        set.status = 404
        return {data: null, error: 'Comparison project not found'}
      }

      const data = await resetComparisonProjectConflictResolution({articleId: body.articleId, scope})

      return {data}
    },
    {body: t.Object({articleId: t.String()})},
  )
  .post(
    '/api/comparison-projects/:id/export',
    async (context) => {
      const {params, body, set} = context
      const data = await getComparisonProjectScope(params.id)

      if (!data) {
        set.status = 404
        return {data: null, error: 'Comparison project not found'}
      }

      const differenceFilter = getRequestedComparisonProjectDifferenceFilter({differenceFilter: body.differenceFilter})
      const rowFilter = getNormalizedComparisonProjectRowFilter(body.rowFilter)

      return getComparisonProjectExportResponse(data, rowFilter, differenceFilter)
    },
    {
      body: t.Object({
        rowFilter: t.Optional(t.String()),
        differenceFilter: t.Optional(
          t.Union([
            t.Literal('all'),
            t.Literal('human-vs-llm'),
            t.Literal('human-vs-llm-true-conflict'),
            t.Literal('llm-vs-llm'),
            t.Literal('any-disagreement'),
          ]),
        ),
      }),
    },
  )
  .post(
    '/api/comparison-projects',
    async (context) => {
      const {body} = context
      const createdComparisonProject = (await appDatabaseService.transaction(async (tx) => {
        return createComparisonProjectRecord(tx, body)
      })) as Awaited<ReturnType<typeof createComparisonProjectRecord>>
      await markComparisonProjectServingStaleAndQueueRebuild(createdComparisonProject.id)

      return {data: createdComparisonProject}
    },
    {
      body: t.Object({
        name: t.String(),
        description: t.Optional(t.Union([t.String(), t.Null()])),
        modelIds: t.Optional(t.Array(t.String())),
        compareWithHumans: t.Optional(t.Boolean()),
        allowConflictResolution: t.Optional(t.Boolean()),
        humanJudgmentMode: t.Optional(t.Union([t.Literal('prompt'), t.Literal('summary')])),
        summarySourceProjectId: t.Optional(t.Union([t.String(), t.Null()])),
        useTitle: t.Boolean(),
        useAbstract: t.Boolean(),
        useFulltext: t.Boolean(),
        useFulltextNoImages: t.Boolean(),
        importRoutes: t.Optional(t.Array(t.String())),
        sourceProjectIds: t.Optional(t.Array(t.String())),
        promptSelections: t.Optional(t.Array(t.Object({promptId: t.String(), order: t.Number()}))),
      }),
    },
  )
  .patch(
    '/api/comparison-projects/:id',
    async (context) => {
      const {params, body, set} = context
      const existingComparisonProject = await getComparisonProjectEditFormData(params.id)

      if (!existingComparisonProject) {
        set.status = 404
        return {data: null, error: 'Comparison project not found'}
      }

      const useTitle = body.useTitle
      const useAbstract = body.useAbstract
      const useFulltext = body.useFulltext
      const useFulltextNoImages = body.useFulltextNoImages

      if (!useTitle && !useAbstract && !useFulltext && !useFulltextNoImages) {
        throw new Error('Select at least one article content option to compare')
      }

      const validatedModelIds = await getValidatedModelIds(
        appDatabaseService,
        getUniqueStringValues(body.modelIds ?? []),
      )
      const [existingModelIdsRow] = await appDatabaseService.queryJson<{modelIds: unknown}>(`
        SELECT model_ids AS modelIds
        FROM ${comparisonProjectTable}
        WHERE id = ${getSqlLiteral(params.id)}
        LIMIT 1
      `)
      const existingModelIds = getDuckdbStringArrayValue(existingModelIdsRow?.modelIds)
      const humanJudgmentMode = body.humanJudgmentMode ?? existingComparisonProject.humanJudgmentMode
      const summarySourceProjectId =
        humanJudgmentMode === 'summary'
          ? getSummarySourceProjectId(body.summarySourceProjectId ?? existingComparisonProject.summarySourceProjectId)
          : null
      const validatedPromptSelections = await getValidatedComparisonPromptSelections(appDatabaseService, {
        compareWithHumans: body.compareWithHumans,
        humanJudgmentMode,
        promptSelections: body.promptSelections,
        summarySourceProjectId,
      })
      const uniqueImportRoutes =
        body.importRoutes === undefined ? undefined : getUniqueStringValues(body.importRoutes ?? [])
      const validatedSourceProjectIds =
        body.sourceProjectIds === undefined
          ? undefined
          : await getValidatedComparisonSourceProjectIds(appDatabaseService, body.sourceProjectIds ?? [])
      const baseSetParts = [
        `name = ${getSqlLiteral(body.name)}`,
        `description = ${getSqlLiteral(body.description?.trim() || null)}`,
        `compare_with_humans = ${getBooleanLiteral(body.compareWithHumans)}`,
        `allow_conflict_resolution = ${getBooleanLiteral(body.allowConflictResolution)}`,
        `human_judgment_mode = ${getSqlLiteral(humanJudgmentMode)}`,
        `summary_source_project_id = ${getSqlLiteral(summarySourceProjectId)}`,
        `use_title = ${getBooleanLiteral(useTitle)}`,
        `use_abstract = ${getBooleanLiteral(useAbstract)}`,
        `use_fulltext = ${getBooleanLiteral(useFulltext)}`,
        `use_fulltext_no_images = ${getBooleanLiteral(useFulltextNoImages)}`,
        `updated_at = current_timestamp`,
      ]
      const hasModelIdsChange = !hasSameStringArrayValue(validatedModelIds, existingModelIds)
      const setParts = hasModelIdsChange
        ? [...baseSetParts, `model_ids = ${getSqlLiteral(validatedModelIds)}`]
        : baseSetParts

      const updatedComparisonProjectRow = await updateComparisonProjectWithRelinkedLinks({
        comparisonProjectId: params.id,
        importRoutes: uniqueImportRoutes,
        setParts,
        sourceProjectIds: validatedSourceProjectIds,
        promptSelections: validatedPromptSelections,
      })

      if (!updatedComparisonProjectRow) {
        throw new Error('Comparison project not found')
      }

      await markComparisonProjectServingStaleAndQueueRebuild(params.id)

      return {data: getComparisonProjectRecordValue(updatedComparisonProjectRow)}
    },
    {
      body: t.Object({
        name: t.String(),
        description: t.Optional(t.Union([t.String(), t.Null()])),
        compareWithHumans: t.Boolean(),
        allowConflictResolution: t.Boolean(),
        humanJudgmentMode: t.Optional(t.Union([t.Literal('prompt'), t.Literal('summary')])),
        summarySourceProjectId: t.Optional(t.Union([t.String(), t.Null()])),
        modelIds: t.Optional(t.Array(t.String())),
        useTitle: t.Boolean(),
        useAbstract: t.Boolean(),
        useFulltext: t.Boolean(),
        useFulltextNoImages: t.Boolean(),
        importRoutes: t.Optional(t.Array(t.String())),
        sourceProjectIds: t.Optional(t.Array(t.String())),
        promptSelections: t.Array(t.Object({promptId: t.String(), order: t.Number()})),
      }),
    },
  )
  .delete('/api/comparison-projects/:id', async (context) => {
    const {params, set} = context
    const archivedComparisonProject = await appDatabaseService.transaction(async (tx) => {
      return updateComparisonProjectTx(tx, {
        comparisonProjectId: params.id,
        setParts: ['archived = TRUE', 'updated_at = current_timestamp'],
      })
    })

    if (!archivedComparisonProject) {
      set.status = 404
      return {success: false, error: 'Comparison project not found'}
    }

    return {success: true}
  })
  .post('/api/comparison-projects/:id/unarchive', async (context) => {
    const {params, set} = context
    const unarchivedComparisonProject = await appDatabaseService.transaction(async (tx) => {
      return updateComparisonProjectTx(tx, {
        comparisonProjectId: params.id,
        setParts: ['archived = FALSE', 'updated_at = current_timestamp'],
      })
    })

    if (!unarchivedComparisonProject) {
      set.status = 404
      return {success: false, error: 'Comparison project not found'}
    }

    return {success: true}
  })
