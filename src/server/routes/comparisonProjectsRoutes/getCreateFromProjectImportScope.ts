import {
  getComparisonProjectContentDimensions,
  getComparisonProjectFullTextStrategyLabels,
} from './comparisonProjectContentDimensions.ts'
import {getComparisonProjectRecordValue} from './comparisonProjectRecord.ts'
import {importRouteTable} from './comparisonProjectRouteConstants.ts'
import type {AppQueryRunner, ComparisonProjectSource, PromptSelection} from './comparisonProjectRouteTypes.ts'
import type {
  ComparisonProjectLinkedSourceProject,
  ComparisonProjectModelConfig,
  ComparisonProjectScope,
  ComparisonProjectSourceSummaryPromptConfig,
  ComparisonProjectSummarySourceProject,
} from './comparisonProjectScopeTypes.ts'
import {getInClause} from './comparisonProjectSqlClauses.ts'
import {getPromptLabel} from './comparisonProjectValueHelpers.ts'
import {getComparisonProjectColumns} from './getComparisonProjectColumns.ts'
import {getComparisonProjectContentVariants} from './getComparisonProjectContentVariants.ts'
import {getComparisonProjectPromptConfigsForSelections} from './getComparisonProjectPromptConfigsForSelections.ts'
import {getEmptyComparisonProjectServingProgress} from './getEmptyComparisonProjectServingProgress.ts'
import {getSourceProjectSummaryPromptSelections} from './getSourceProjectSummaryPromptSelections.ts'

const getComparisonProjectSourceProjectFromSource = (
  sourceProject: ComparisonProjectSource,
): ComparisonProjectLinkedSourceProject => {
  return {
    id: sourceProject.id,
    name: sourceProject.name,
    description: sourceProject.description,
    modelId: sourceProject.modelId,
    modelName: sourceProject.modelName,
    humanJudgmentMode: sourceProject.humanJudgmentMode,
    systemPromptVariant: sourceProject.systemPromptVariant,
    useMetadata: sourceProject.useMetadata,
    fullTextStrategyId: sourceProject.fullTextStrategyId,
  }
}

const getComparisonProjectSummarySourceProjectFromSource = (
  sourceProject: ComparisonProjectSource | undefined,
): ComparisonProjectSummarySourceProject | null => {
  return sourceProject
    ? {
        id: sourceProject.id,
        name: sourceProject.name,
        description: sourceProject.description,
        modelId: sourceProject.modelId,
        modelName: sourceProject.modelName,
        humanJudgmentMode: sourceProject.humanJudgmentMode,
        useTitle: sourceProject.useTitle,
        useAbstract: sourceProject.useAbstract,
        useFulltext: sourceProject.useFulltext,
        useFulltextNoImages: sourceProject.useFulltextNoImages,
        useMetadata: sourceProject.useMetadata,
      }
    : null
}

const getComparisonProjectModelConfigsFromSources = (
  selectedSourceProjects: ComparisonProjectSource[],
): ComparisonProjectModelConfig[] => {
  return Array.from(
    selectedSourceProjects
      .reduce<Map<string, ComparisonProjectModelConfig>>((modelMap, sourceProject) => {
        if (!modelMap.has(sourceProject.modelId)) {
          modelMap.set(sourceProject.modelId, {
            id: sourceProject.modelId,
            metadataJson: sourceProject.modelMetadataJson ?? {},
            name: sourceProject.modelName,
            provider: sourceProject.modelProvider ?? null,
            version: sourceProject.modelVersion ?? null,
          })
        }

        return modelMap
      }, new Map<string, ComparisonProjectModelConfig>())
      .values(),
  )
}

const getComparisonProjectSourceSummaryPromptConfigsFromSources = (
  selectedSourceProjects: ComparisonProjectSource[],
) => {
  return selectedSourceProjects.flatMap<ComparisonProjectSourceSummaryPromptConfig>((sourceProject) => {
    return getSourceProjectSummaryPromptSelections(sourceProject).map((promptSelection) => {
      const sourcePrompt = sourceProject.prompts.find((prompt) => {
        return prompt.id === promptSelection.promptId
      })
      const order = promptSelection.order

      return {
        id: promptSelection.promptId,
        sourceProjectId: sourceProject.id,
        originalText: sourcePrompt?.originalText ?? '',
        promptHeading: sourcePrompt?.promptHeading ?? null,
        promptLabel: getPromptLabel(sourcePrompt?.promptHeading ?? null, order),
        transformedText: sourcePrompt?.transformedText ?? null,
        type: null,
        order,
        criteriaDisposition: promptSelection.criteriaDisposition ?? null,
        criteriaSectionKey: promptSelection.criteriaSectionKey ?? null,
        criteriaSectionLabel: promptSelection.criteriaSectionLabel ?? null,
      }
    })
  })
}

const getImportRouteIdsForRoutes = async (tx: AppQueryRunner, importRoutes: string[]) => {
  if (importRoutes.length === 0) {
    return []
  }

  const routeRows = await tx.queryJson<{id: string; route: string}>(`
    SELECT id, route
    FROM ${importRouteTable}
    WHERE route IN (${getInClause(importRoutes)})
  `)

  if (routeRows.length !== importRoutes.length) {
    throw new Error('One or more import routes were not found')
  }

  const routeIdByRoute = new Map(
    routeRows.map((routeRow) => {
      return [routeRow.route, routeRow.id] as const
    }),
  )

  return importRoutes.map((importRoute) => {
    return routeIdByRoute.get(importRoute) ?? importRoute
  })
}

export const getCreateFromProjectImportScope = async (params: {
  createdComparisonProject: ReturnType<typeof getComparisonProjectRecordValue>
  promptSelections: PromptSelection[]
  selectedImportRoutes: string[]
  selectedSourceProjectIds: string[]
  selectedSourceProjects: ComparisonProjectSource[]
  summarySourceProjectId: string | null
  tx: AppQueryRunner
}): Promise<ComparisonProjectScope> => {
  const promptConfigs = await getComparisonProjectPromptConfigsForSelections(params.tx, params.promptSelections)
  const sourceProjects = params.selectedSourceProjects.map(getComparisonProjectSourceProjectFromSource)
  const summarySourceProject = getComparisonProjectSummarySourceProjectFromSource(
    params.selectedSourceProjects.find((sourceProject) => {
      return sourceProject.id === params.summarySourceProjectId
    }),
  )
  const contentDimensions = getComparisonProjectContentDimensions(sourceProjects)
  const contentVariants = getComparisonProjectContentVariants(
    params.createdComparisonProject,
    contentDimensions,
    await getComparisonProjectFullTextStrategyLabels(params.tx, contentDimensions),
  )
  const selectedImportRouteIds = await getImportRouteIdsForRoutes(params.tx, params.selectedImportRoutes)
  const sourceProjectSummaryPrompts = getComparisonProjectSourceSummaryPromptConfigsFromSources(
    params.selectedSourceProjects,
  )
  const modelRows = getComparisonProjectModelConfigsFromSources(params.selectedSourceProjects)
  const columns = getComparisonProjectColumns(
    promptConfigs,
    modelRows,
    contentVariants,
    params.createdComparisonProject.compareWithHumans,
    params.createdComparisonProject.humanJudgmentMode,
    params.summarySourceProjectId,
    summarySourceProject,
    sourceProjects,
    true,
  )

  return {
    ...params.createdComparisonProject,
    activeGeneration: null,
    judgmentContextId: null,
    isServingReady: false,
    servingStatus: 'missing',
    servingProgress: getEmptyComparisonProjectServingProgress(),
    servingUpdatedAt: null,
    summarySourceProjectId: params.summarySourceProjectId,
    sourceProjectIds: params.selectedSourceProjectIds,
    useImportRoutesForScope: false,
    summarySourceProject,
    sourceProjects,
    contentVariants,
    prompts: promptConfigs,
    sourceProjectSummaryPrompts,
    models: modelRows,
    importRouteIds: selectedImportRouteIds,
    columns,
  }
}
