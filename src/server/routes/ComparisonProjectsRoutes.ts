import {Elysia, t} from 'elysia'

import type {
  ComparisonProjectRecord,
  HumanJudgmentMode,
  ProjectPromptCriteriaDisposition,
} from '../../db/schemaTypes.ts'
import {
  type ComparisonProjectDifferenceColumn,
  type ComparisonProjectDifferenceFilter,
  getComparisonProjectHasDifferenceFilterMatch,
  getNormalizedComparisonProjectDifferenceFilter,
} from '../../utils/comparisonProjectDifferenceFilter.ts'
import {appendProviderModelThinkingBadgeLabel} from '../../utils/providerModelLabel.ts'
import {getProviderModelMetadataOptions} from '../providers/providerModelMetadata.ts'
import {assertSelectableProviderModelIds} from '../providers/providerModelRepository.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import * as appQueryHelpers from '../services/appQueryHelpers.ts'
import {
  deriveStrictSummaryAnswer,
  getJudgmentDisplayAnswer,
  getNormalizedSummaryAnswer,
  hasAnyJudgmentAnswer,
  normalizeSummaryAnswerValue,
} from '../utils/judgmentAnswers.ts'
import {withErrorHandler} from '../utils/routeErrorHandler.ts'

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
  order: number
  criteriaDisposition: ProjectPromptCriteriaDisposition | null
  criteriaSectionKey: string | null
  criteriaSectionLabel: string | null
}
type ComparisonProjectModelConfig = {id: string; metadataJson: unknown; name: string}
type ComparisonProjectJudgmentsColumn = ComparisonProjectDifferenceColumn & {
  promptLabel: string
  modelId: string | null
  modelLabel: string
  contentLabel: string | null
}
type ComparisonProjectScope = {
  id: string
  name: string
  description: string | null
  compareWithHumans: boolean
  humanJudgmentMode: HumanJudgmentMode
  summarySourceProjectId: string | null
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  archived: boolean
  createdAt: Date
  modelIds: string[] | null
  sourceProjectId: string | null
  summarySourceProject: ComparisonProjectSummarySourceProject | null
  contentVariants: ComparisonProjectContentVariant[]
  prompts: ComparisonProjectPromptConfig[]
  models: ComparisonProjectModelConfig[]
  importRouteIds: string[]
  columns: ComparisonProjectJudgmentsColumn[]
}
type ComparisonProjectLlmRow = {
  articleId: string
  createdAt: Date
  promptId: string
  modelId: string
  answeredOriginal: string | null
  answeredOriginalAsArray: string[] | null
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
}
type ComparisonProjectHumanRow = {articleId: string; promptId: string; answer: string | null; updatedAt: Date | null}
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

const comparisonProjectTable = 'app.comparison_project'
const comparisonProjectPromptTable = 'app.comparison_project_prompt'
const comparisonProjectImportRouteTable = 'app.comparison_project_import_route'
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
const {getDateValue, getJsonValue, getQuotedStringList, getSqlLiteral} = appQueryHelpers
const summaryPromptId = 'summary'
const summaryPromptLabel = 'Overall decision'

const getRequiredDateValue = (value: unknown) => {
  const parsedDate = getDateValue(value)
  return parsedDate ?? new Date(0)
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

const getArticleMatchesProjectClause = (articleAlias: string, projectId: string | null) => {
  return !projectId
    ? null
    : `EXISTS (
        SELECT 1
        FROM ${projectArticleTable} pa
        WHERE pa.article_id = ${articleAlias}.id
          AND pa.project_id = ${getSqlLiteral(projectId)}
      )`
}

const getArticleInScopeClause = (articleAlias: string, routeIds: string[], projectId: string | null) => {
  const importRouteClause = getArticleMatchesImportRouteClause(articleAlias, routeIds)
  const projectClause = getArticleMatchesProjectClause(articleAlias, projectId)
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

const getComparisonProjectContentKey = (settings: {
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
}) => {
  return [settings.useTitle, settings.useAbstract, settings.useFulltext, settings.useFulltextNoImages]
    .map((value) => {
      return (value ? 1 : 0).toString()
    })
    .join('')
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

const getColumnId = (kind: 'llm' | 'human', promptId: string, modelId?: string | null, contentKey?: string | null) => {
  return kind === 'human' ? `human:${promptId}` : `llm:${modelId}:${contentKey ?? 'default'}:${promptId}`
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
      p.human_judgment_mode AS humanJudgmentMode,
      p.use_title AS useTitle,
      p.use_abstract AS useAbstract,
      p.use_fulltext AS useFulltext,
      p.use_fulltext_no_images AS useFulltextNoImages
    FROM ${projectTable} p
    INNER JOIN ${modelTable} m ON m.id = p.model_id
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
          thinking: getProviderModelMetadataOptions(getJsonValue(projectRow.modelMetadataJson)).thinking,
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

const getArticleScopeConditions = (routeIds: string[], sourceProjectId: string | null, searchTitle?: string | null) => {
  const trimmedSearchTitle = searchTitle?.trim() ?? ''
  const scopeCondition = getArticleInScopeClause('a', routeIds, sourceProjectId)

  return [
    scopeCondition,
    trimmedSearchTitle ? getCaseInsensitiveContainsClause('a.article_title', trimmedSearchTitle) : null,
  ].filter(isDefined)
}

const getComparisonProjectModels = async (
  comparisonProjectRow: {
    modelIds: string[] | null
    sourceProjectId: string | null
    contentVariants: ComparisonProjectContentVariant[]
  },
  promptIds: string[],
  importRouteIds: string[],
) => {
  const selectedModelIds = comparisonProjectRow.modelIds ?? []

  if (selectedModelIds.length > 0) {
    const modelRows = await appDatabaseService.queryJson<ComparisonProjectModelConfig>(`
      SELECT id, name
      FROM ${modelTable}
      WHERE id IN (${getInClause(selectedModelIds)})
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

  const articleScopeConditions = getArticleScopeConditions(importRouteIds, comparisonProjectRow.sourceProjectId)
  return appDatabaseService.queryJson<ComparisonProjectModelConfig>(`
    SELECT m.id AS id, m.name AS name, TO_JSON(m.metadata_json) AS metadataJson
    FROM ${judgmentTable} j
    INNER JOIN ${modelTable} m ON m.id = j.model_id
    INNER JOIN ${articleTable} a ON a.id = j.article_id
    ${getWhereClause([
      `j.prompt_id IN (${getInClause(promptIds)})`,
      'j.deleted_at IS NULL',
      contentCondition,
      ...articleScopeConditions,
    ])}
    GROUP BY m.id, m.name, m.metadata_json
    ORDER BY m.name ASC
  `)
}

const getComparisonProjectColumns = (
  promptRows: ComparisonProjectPromptConfig[],
  modelRows: ComparisonProjectModelConfig[],
  contentVariants: ComparisonProjectContentVariant[],
  compareWithHumans: boolean,
  humanJudgmentMode: HumanJudgmentMode,
) => {
  const shownPromptRows =
    compareWithHumans && humanJudgmentMode === 'summary'
      ? [{id: summaryPromptId, promptLabel: summaryPromptLabel}]
      : promptRows
  const llmColumns = shownPromptRows.flatMap((promptRow) => {
    return modelRows.flatMap((modelRow) => {
      return contentVariants.map<ComparisonProjectJudgmentsColumn>((contentVariant) => {
        return {
          id: getColumnId('llm', promptRow.id, modelRow.id, contentVariant.key),
          kind: 'llm',
          promptId: promptRow.id,
          promptLabel: promptRow.promptLabel,
          modelId: modelRow.id,
          modelLabel: appendProviderModelThinkingBadgeLabel({
            label: modelRow.name,
            thinking: getProviderModelMetadataOptions(getJsonValue(modelRow.metadataJson)).thinking,
          }),
          contentLabel: contentVariant.label,
        }
      })
    })
  })
  const humanColumns = compareWithHumans
    ? shownPromptRows.map<ComparisonProjectJudgmentsColumn>((promptRow) => {
        return {
          id: getColumnId('human', promptRow.id),
          kind: 'human',
          promptId: promptRow.id,
          promptLabel: promptRow.promptLabel,
          modelId: null,
          modelLabel: 'Human',
          contentLabel: null,
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
  const [promptRows, routeRows] = await Promise.all([
    appDatabaseService.queryJson<{
      id: string
      promptHeading: string | null
      order: number | null
      criteriaDisposition: ProjectPromptCriteriaDisposition | null
      criteriaSectionKey: string | null
      criteriaSectionLabel: string | null
    }>(`
      SELECT
        p.id AS id,
        p.prompt_heading AS promptHeading,
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
  ])

  const promptConfigs = promptRows.map<ComparisonProjectPromptConfig>((promptRow, index) => {
    const order = promptRow.order ?? index

    return {
      id: promptRow.id,
      promptHeading: promptRow.promptHeading,
      promptLabel: getPromptLabel(promptRow.promptHeading, order),
      order,
      criteriaDisposition: promptRow.criteriaDisposition,
      criteriaSectionKey: promptRow.criteriaSectionKey,
      criteriaSectionLabel: promptRow.criteriaSectionLabel,
    }
  })
  const importRouteIds = routeRows.map((routeRow) => {
    return routeRow.importRouteId
  })
  const sourceProjectId =
    normalizedComparisonProjectRow.summarySourceProjectId
    ?? (await getInferredSourceProjectId(normalizedComparisonProjectRow, promptConfigs, importRouteIds))
  const contentVariants = getComparisonProjectContentVariants(normalizedComparisonProjectRow)
  const [summarySourceProject, modelRows] = await Promise.all([
    getSummarySourceProject(normalizedComparisonProjectRow.summarySourceProjectId),
    getComparisonProjectModels(
      {...normalizedComparisonProjectRow, sourceProjectId, contentVariants},
      promptConfigs.map((prompt) => {
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
  )

  return {
    ...normalizedComparisonProjectRow,
    sourceProjectId,
    summarySourceProject,
    contentVariants,
    prompts: promptConfigs,
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
          WHERE id IN (${getInClause(configuredModelIds)})
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

  const [selectedPromptRows, availablePromptRows] = await Promise.all([
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
  ])
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
  const summarySourceProject = await getSummarySourceProject(normalizedComparisonProjectRow.summarySourceProjectId)

  return {
    ...normalizedComparisonProjectRow,
    summarySourceProject,
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

const getRowsByArticleId = <T extends {articleId: string}>(rows: T[]) => {
  return rows.reduce<Map<string, T[]>>((rowMap, row) => {
    const currentRows = rowMap.get(row.articleId) ?? []
    currentRows.push(row)
    rowMap.set(row.articleId, currentRows)
    return rowMap
  }, new Map<string, T[]>())
}

const getComparisonProjectAnsweredPromptIds = (
  llmRows: ComparisonProjectLlmRow[],
  humanRows: ComparisonProjectHumanRow[],
) => {
  const answeredPromptIds = new Set<string>()

  llmRows.forEach((row) => {
    if (hasAnyJudgmentAnswer(row)) {
      answeredPromptIds.add(row.promptId)
    }
  })
  humanRows.forEach((row) => {
    if ((row.answer?.trim() ?? '') !== '') {
      answeredPromptIds.add(row.promptId)
    }
  })

  return answeredPromptIds
}

const getComparisonProjectAnsweredColumnCount = (
  llmCells: Record<string, string | null> | undefined,
  humanCells: Record<string, string | null> | undefined,
  columnIds: Set<string>,
) => {
  return Array.from(columnIds).filter((columnId) => {
    return hasValue(llmCells?.[columnId]) || hasValue(humanCells?.[columnId])
  }).length
}

const hasValue = (value: string | null | undefined) => {
  return (value?.trim() ?? '') !== ''
}

const getComparisonProjectRequiredColumnIds = (
  scope: ComparisonProjectScope,
  kind: ComparisonProjectJudgmentsColumn['kind'],
) => {
  return new Set(
    scope.columns
      .filter((column) => {
        return column.kind === kind
      })
      .map((column) => {
        return column.id
      }),
  )
}

const getHasAllRequiredColumns = (
  cellMap: Record<string, string | null> | undefined,
  requiredColumnIds: Set<string>,
) => {
  return Array.from(requiredColumnIds).every((columnId) => {
    return hasValue(cellMap?.[columnId])
  })
}

const getComparisonProjectLlmRows = async (scope: ComparisonProjectScope, articleIds: string[]) => {
  const promptIds = scope.prompts.map((prompt) => {
    return prompt.id
  })
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
        answeredOriginalAsArray: getStringArrayRowValue(row, 'answeredOriginalAsArray'),
      }
    })
    .filter((row) => {
      return hasAnyJudgmentAnswer(row)
    })
}

const getSummaryCriteria = (scope: ComparisonProjectScope) => {
  return scope.prompts.map((prompt) => {
    return {promptId: prompt.id, criteriaDisposition: prompt.criteriaDisposition}
  })
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

  const rowGroups = rows.reduce<Map<string, ComparisonProjectLlmRow[]>>((rowMap, row) => {
    const key = `${row.articleId}:${row.modelId}:${getComparisonProjectContentKey(row)}`
    const currentRows = rowMap.get(key) ?? []
    rowMap.set(key, [...currentRows, row])
    return rowMap
  }, new Map<string, ComparisonProjectLlmRow[]>())

  return Array.from(rowGroups.values())
    .map<ComparisonProjectLlmRow | null>((groupRows) => {
      const [firstRow] = groupRows

      if (!firstRow) {
        return null
      }

      const normalizedAnswers = Array.from(getLatestComparisonProjectLlmRowsByPromptId(groupRows).values()).reduce<
        Record<string, 'yes' | 'no' | 'maybe' | null>
      >((answerMap, row) => {
        return {...answerMap, [row.promptId]: getNormalizedSummaryAnswer(row)}
      }, {})
      const summaryAnswer = deriveStrictSummaryAnswer(getSummaryCriteria(scope), normalizedAnswers)

      return summaryAnswer
        ? {...firstRow, promptId: summaryPromptId, answeredOriginal: summaryAnswer, answeredOriginalAsArray: null}
        : null
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

const getComparisonProjectLlmCells = (rows: ComparisonProjectLlmRow[]) => {
  return rows.reduce<Record<string, Record<string, string | null>>>((articleMap, row) => {
    const articleCells = articleMap[row.articleId] ?? {}
    const columnId = getColumnId('llm', row.promptId, row.modelId, getComparisonProjectContentKey(row))

    return {...articleMap, [row.articleId]: {...articleCells, [columnId]: getJudgmentDisplayAnswer(row)}}
  }, {})
}

const getComparisonProjectHumanCells = (rows: ComparisonProjectHumanRow[]) => {
  const latestRows = rows.reduce<Map<string, ComparisonProjectHumanRow>>((rowMap, row) => {
    const key = `${row.articleId}:${row.promptId}`
    const existingRow = rowMap.get(key)

    if (!existingRow || (row.updatedAt?.getTime() ?? 0) > (existingRow.updatedAt?.getTime() ?? 0)) {
      rowMap.set(key, row)
    }

    return rowMap
  }, new Map<string, ComparisonProjectHumanRow>())
  const groupedAnswers = Array.from(latestRows.values()).reduce<Record<string, Record<string, string[]>>>(
    (articleMap, row) => {
      const articleCells = articleMap[row.articleId] ?? {}
      const columnId = getColumnId('human', row.promptId)
      const existingAnswers = articleCells[columnId] ?? []

      return row.answer
        ? {...articleMap, [row.articleId]: {...articleCells, [columnId]: [...existingAnswers, row.answer.trim()]}}
        : articleMap
    },
    {},
  )

  return Object.entries(groupedAnswers).reduce<Record<string, Record<string, string | null>>>(
    (articleMap, [articleId, articleCells]) => {
      const normalizedCells = Object.entries(articleCells).reduce<Record<string, string | null>>(
        (cellMap, [columnId, answers]) => {
          const uniqueAnswers = Array.from(
            new Set(
              answers.filter((answer) => {
                return answer !== ''
              }),
            ),
          ).sort((left, right) => {
            return left.localeCompare(right)
          })

          return {...cellMap, [columnId]: uniqueAnswers.length > 0 ? uniqueAnswers.join('\n') : null}
        },
        {},
      )

      return {...articleMap, [articleId]: normalizedCells}
    },
    {},
  )
}

const getComparisonProjectJudgmentsPage = async (
  scope: ComparisonProjectScope,
  page: number,
  limit: number,
  hideSparseRows: boolean,
  showOnlyFullyAnsweredPrompts: boolean,
  differenceFilter: ComparisonProjectDifferenceFilter,
) => {
  if (scope.prompts.length === 0 || scope.columns.length === 0) {
    return {data: [], totalCount: 0, page: 1, limit, totalPages: 0}
  }

  const articleScopeConditions = getArticleScopeConditions(scope.importRouteIds, scope.sourceProjectId)

  const scopedArticles = await appDatabaseService
    .queryJson<{id: string; articleTitle: string; articleCreatedAt: unknown}>(
      `
      SELECT id, article_title AS articleTitle, article_created_at AS articleCreatedAt
      FROM ${articleTable} a
      ${getWhereClause(articleScopeConditions)}
      ORDER BY a.article_created_at DESC, a.article_title ASC, a.id ASC
    `,
    )
    .then((rows) => {
      return rows.map((row) => {
        return {...row, articleCreatedAt: getDateValue(row.articleCreatedAt)}
      })
    })
  const articleIds = scopedArticles.map((article) => {
    return article.id
  })
  const [rawLlmRows, humanRows] = await Promise.all([
    getComparisonProjectLlmRows(scope, articleIds),
    getComparisonProjectHumanRows(scope, articleIds),
  ])
  const llmRows = getComparisonProjectLlmSummaryRows(scope, rawLlmRows)
  const llmRowsByArticle = getRowsByArticleId(llmRows)
  const humanRowsByArticle = getRowsByArticleId(humanRows)
  const llmCellsByArticle = getComparisonProjectLlmCells(llmRows)
  const humanCellsByArticle = getComparisonProjectHumanCells(humanRows)
  const requiredLlmColumnIds = getComparisonProjectRequiredColumnIds(scope, 'llm')
  const requiredHumanColumnIds = getComparisonProjectRequiredColumnIds(scope, 'human')
  const requiredColumnIds = new Set([...requiredLlmColumnIds, ...requiredHumanColumnIds])
  const normalizedDifferenceFilter = getNormalizedComparisonProjectDifferenceFilter(differenceFilter, scope.columns)
  const filteredArticles = scopedArticles.filter((article) => {
    const articleLlmRows = llmRowsByArticle.get(article.id) ?? []
    const articleHumanRows = humanRowsByArticle.get(article.id) ?? []
    const articleCells = {...(llmCellsByArticle[article.id] ?? {}), ...(humanCellsByArticle[article.id] ?? {})}
    const hasArticleData = articleLlmRows.length > 0 || articleHumanRows.length > 0
    const answeredPromptIds = getComparisonProjectAnsweredPromptIds(articleLlmRows, articleHumanRows)
    const answeredColumnCount = getComparisonProjectAnsweredColumnCount(
      llmCellsByArticle[article.id],
      humanCellsByArticle[article.id],
      requiredColumnIds,
    )
    const hasAllLlmColumns = getHasAllRequiredColumns(llmCellsByArticle[article.id], requiredLlmColumnIds)
    const hasAllHumanColumns = getHasAllRequiredColumns(humanCellsByArticle[article.id], requiredHumanColumnIds)
    const passesDifferenceFilter = getComparisonProjectHasDifferenceFilterMatch(
      articleCells,
      scope.columns,
      normalizedDifferenceFilter,
    )

    return (
      hasArticleData
      && (!hideSparseRows || (getIsSummaryMode(scope) ? answeredColumnCount >= 2 : answeredPromptIds.size >= 2))
      && (!showOnlyFullyAnsweredPrompts || (hasAllLlmColumns && hasAllHumanColumns))
      && passesDifferenceFilter
    )
  })
  const totalCount = filteredArticles.length
  const totalPages = totalCount > 0 ? Math.ceil(totalCount / limit) : 0
  const safePage = totalPages > 0 ? Math.min(Math.max(page, 1), totalPages) : 1
  const offset = (safePage - 1) * limit
  const pageArticles = filteredArticles.slice(offset, offset + limit)
  const data = pageArticles.map((article) => {
    return {
      id: article.id,
      articleTitle: article.articleTitle,
      articleCreatedAt: article.articleCreatedAt,
      cells: {...(llmCellsByArticle[article.id] ?? {}), ...(humanCellsByArticle[article.id] ?? {})},
    }
  })

  return {data, totalCount, page: safePage, limit, totalPages}
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

const insertComparisonProjectImportRouteRows = async (
  tx: AppTx,
  comparisonProjectId: string,
  routeRows: Array<{id: string; importRouteId: string}>,
) => {
  const [currentRouteRow] = routeRows

  if (!currentRouteRow) {
    return
  }

  await tx.run(`
    INSERT INTO ${comparisonProjectImportRouteTable} (id, comparison_project_id, import_route_id)
    VALUES (
      ${getSqlLiteral(currentRouteRow.id)},
      ${getSqlLiteral(comparisonProjectId)},
      ${getSqlLiteral(currentRouteRow.importRouteId)}
    )
  `)

  return insertComparisonProjectImportRouteRows(tx, comparisonProjectId, routeRows.slice(1))
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

const updateComparisonProjectWithModelIdsChange = async (params: {
  comparisonProjectId: string
  setParts: string[]
  promptSelections: PromptSelection[]
}): Promise<ComparisonProjectRecordRow | null> => {
  return appDatabaseService.transaction(async (tx) => {
    const importRouteRows = await tx.queryJson<{id: string; importRouteId: string}>(`
      SELECT id, import_route_id AS importRouteId
      FROM ${comparisonProjectImportRouteTable}
      WHERE comparison_project_id = ${getSqlLiteral(params.comparisonProjectId)}
    `)
    const updatedComparisonProjectRecord = await updateComparisonProjectTx(tx, {
      comparisonProjectId: params.comparisonProjectId,
      setParts: params.setParts,
    })

    if (!updatedComparisonProjectRecord) {
      throw new Error('Comparison project not found')
    }

    await tx.run(`
      DELETE FROM ${comparisonProjectPromptTable}
      WHERE comparison_project_id = ${getSqlLiteral(params.comparisonProjectId)}
    `)
    await tx.run(`
      DELETE FROM ${comparisonProjectImportRouteTable}
      WHERE comparison_project_id = ${getSqlLiteral(params.comparisonProjectId)}
    `)
    await insertComparisonProjectImportRouteRows(tx, params.comparisonProjectId, importRouteRows)
    await insertComparisonProjectPromptLinks(tx, params.comparisonProjectId, params.promptSelections)

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
    humanJudgmentMode?: HumanJudgmentMode
    summarySourceProjectId?: string | null
    useTitle?: boolean
    useAbstract?: boolean
    useFulltext?: boolean
    useFulltextNoImages?: boolean
    importRoutes?: string[]
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
  const [newComparisonProject] = await tx.queryJson<{
    id: string
    name: string
    description: string | null
    modelIds: unknown
    compareWithHumans: boolean
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
  .post(
    '/api/comparison-projects/from-project',
    async (context) => {
      const {body} = context
      const sources = await getComparisonProjectSources()
      const sourceProject = sources.find((source) => {
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
        humanJudgmentMode === 'summary'
          ? sourceProject.prompts.filter(hasSummaryPromptCriteriaMetadata)
          : sourceProject.prompts
      const createdComparisonProject = (await appDatabaseService.transaction(async (tx) => {
        return createComparisonProjectRecord(tx, {
          name: body.name,
          description: body.description,
          modelIds: [sourceProject.modelId],
          compareWithHumans: body.compareWithHumans,
          humanJudgmentMode,
          summarySourceProjectId,
          useTitle: sourceProject.useTitle,
          useAbstract: sourceProject.useAbstract,
          useFulltext: sourceProject.useFulltext,
          useFulltextNoImages: sourceProject.useFulltextNoImages,
          importRoutes: sourceProject.importRoutes.map((importRoute) => {
            return importRoute.route
          }),
          promptSelections: sourcePromptSelections.map((prompt) => {
            return {
              promptId: prompt.id,
              order: prompt.order,
              criteriaDisposition: prompt.criteriaDisposition,
              criteriaSectionKey: prompt.criteriaSectionKey,
              criteriaSectionLabel: prompt.criteriaSectionLabel,
            }
          }),
        })
      })) as Awaited<ReturnType<typeof createComparisonProjectRecord>>

      return {data: createdComparisonProject}
    },
    {
      body: t.Object({
        name: t.String(),
        description: t.Optional(t.Union([t.String(), t.Null()])),
        compareWithHumans: t.Optional(t.Boolean()),
        humanJudgmentMode: t.Optional(t.Union([t.Literal('prompt'), t.Literal('summary')])),
        summarySourceProjectId: t.Optional(t.Union([t.String(), t.Null()])),
        sourceProjectId: t.String(),
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
  .get('/api/comparison-projects/:id', async (context) => {
    const {params, set} = context
    const data = await getComparisonProjectScope(params.id)

    if (!data) {
      set.status = 404
      return {data: null, error: 'Comparison project not found'}
    }

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

      const parsedPage = Number.parseInt(body.page, 10)
      const parsedLimit = Number.parseInt(body.limit, 10)
      const page = Number.isNaN(parsedPage) ? 1 : parsedPage
      const limit = Number.isNaN(parsedLimit) ? 50 : Math.min(Math.max(parsedLimit, 1), 100)
      const differenceFilter = getRequestedComparisonProjectDifferenceFilter({
        differenceFilter: body.differenceFilter,
        showOnlyModelDifferences: body.showOnlyModelDifferences,
      })
      const judgmentsPage = await getComparisonProjectJudgmentsPage(
        data,
        page,
        limit,
        body.hideSparseRows ?? false,
        body.showOnlyFullyAnsweredPrompts ?? false,
        differenceFilter,
      )

      return {data: judgmentsPage}
    },
    {
      body: t.Object({
        page: t.String(),
        limit: t.String(),
        hideSparseRows: t.Optional(t.Boolean()),
        showOnlyFullyAnsweredPrompts: t.Optional(t.Boolean()),
        differenceFilter: t.Optional(
          t.Union([
            t.Literal('all'),
            t.Literal('human-vs-llm'),
            t.Literal('llm-vs-llm'),
            t.Literal('any-disagreement'),
          ]),
        ),
        showOnlyModelDifferences: t.Optional(t.Boolean()),
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

      return {data: createdComparisonProject}
    },
    {
      body: t.Object({
        name: t.String(),
        description: t.Optional(t.Union([t.String(), t.Null()])),
        modelIds: t.Optional(t.Array(t.String())),
        compareWithHumans: t.Optional(t.Boolean()),
        humanJudgmentMode: t.Optional(t.Union([t.Literal('prompt'), t.Literal('summary')])),
        summarySourceProjectId: t.Optional(t.Union([t.String(), t.Null()])),
        useTitle: t.Boolean(),
        useAbstract: t.Boolean(),
        useFulltext: t.Boolean(),
        useFulltextNoImages: t.Boolean(),
        importRoutes: t.Optional(t.Array(t.String())),
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
      const baseSetParts = [
        `name = ${getSqlLiteral(body.name)}`,
        `description = ${getSqlLiteral(body.description?.trim() || null)}`,
        `compare_with_humans = ${getBooleanLiteral(body.compareWithHumans)}`,
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

      const updatedComparisonProjectRow = hasModelIdsChange
        ? await updateComparisonProjectWithModelIdsChange({
            comparisonProjectId: params.id,
            setParts,
            promptSelections: validatedPromptSelections,
          })
        : ((await appDatabaseService.transaction(async (tx) => {
            const updatedComparisonProjectRecord = await updateComparisonProjectTx(tx, {
              comparisonProjectId: params.id,
              setParts,
            })

            if (!updatedComparisonProjectRecord) {
              throw new Error('Comparison project not found')
            }

            await tx.run(`
              DELETE FROM ${comparisonProjectPromptTable}
              WHERE comparison_project_id = ${getSqlLiteral(params.id)}
            `)
            await insertComparisonProjectPromptLinks(tx, params.id, validatedPromptSelections)

            return updatedComparisonProjectRecord
          })) as ComparisonProjectRecordRow | null)

      if (!updatedComparisonProjectRow) {
        throw new Error('Comparison project not found')
      }

      return {data: getComparisonProjectRecordValue(updatedComparisonProjectRow)}
    },
    {
      body: t.Object({
        name: t.String(),
        description: t.Optional(t.Union([t.String(), t.Null()])),
        compareWithHumans: t.Boolean(),
        humanJudgmentMode: t.Optional(t.Union([t.Literal('prompt'), t.Literal('summary')])),
        summarySourceProjectId: t.Optional(t.Union([t.String(), t.Null()])),
        modelIds: t.Optional(t.Array(t.String())),
        useTitle: t.Boolean(),
        useAbstract: t.Boolean(),
        useFulltext: t.Boolean(),
        useFulltextNoImages: t.Boolean(),
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
