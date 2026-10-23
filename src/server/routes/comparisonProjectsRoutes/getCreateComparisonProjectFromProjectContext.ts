import type {
  ComparisonProjectSource,
  CreateComparisonProjectFromProjectContext,
  CreateComparisonProjectFromProjectSelectionBody,
  PromptSelection,
} from './comparisonProjectRouteTypes.ts'
import {assertComparisonProjectSourcesShareFullTextStrategy} from './comparisonProjectSourceFullTextStrategy.ts'
import {getUniqueStringValues} from './comparisonProjectValueHelpers.ts'
import {getComparisonProjectSources} from './getComparisonProjectSources.ts'
import {getSourceProjectSummaryPromptSelections} from './getSourceProjectSummaryPromptSelections.ts'

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

export const getCreateComparisonProjectFromProjectContext = async (
  body: CreateComparisonProjectFromProjectSelectionBody,
): Promise<CreateComparisonProjectFromProjectContext> => {
  const sources = await getComparisonProjectSources()
  const selectedSourceProjectIds = getUniqueStringValues([body.sourceProjectId, ...(body.sourceProjectIds ?? [])])
  const selectedSourceProjects = getSelectedComparisonProjectSources(sources, selectedSourceProjectIds)
  const sourceProject = selectedSourceProjects.find((source) => {
    return source.id === body.sourceProjectId
  })

  if (!sourceProject) {
    throw new Error('Source project not found')
  }

  assertComparisonProjectSourcesShareFullTextStrategy(selectedSourceProjects)

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
    (humanJudgmentMode === 'summary' ? selectedSourceProjects : [sourceProject]).flatMap((selectedSourceProject) => {
      return selectedSourceProject.importRoutes.map((importRoute) => {
        return importRoute.route
      })
    }),
  )

  return {
    humanJudgmentMode,
    selectedImportRoutes,
    selectedModelIds,
    selectedSourceProjectIds,
    selectedSourceProjects,
    sourceProject,
    sourcePromptSelections,
    summarySourceProjectId,
  }
}
