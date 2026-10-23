import type {HumanJudgmentMode} from '../../../db/schemaTypes.ts'
import {
  appendProviderModelThinkingBadgeLabel,
  getProviderModelThinkingBadgeValue,
} from '../../../utils/providerModelLabel.ts'
import {getProviderModelMetadataOptions} from '../../providers/providerModelMetadata.ts'
import {getJsonValue} from '../../services/appQueryHelpers.ts'
import {getComparisonProjectContentLabel} from './comparisonProjectContentDimensions.ts'
import {getComparisonProjectColumnId} from './comparisonProjectJudgmentRows.ts'
import {summaryPromptId} from './comparisonProjectRouteConstants.ts'
import type {
  ComparisonProjectContentVariant,
  ComparisonProjectJudgmentsColumn,
  ComparisonProjectLinkedSourceProject,
  ComparisonProjectModelConfig,
  ComparisonProjectPromptConfig,
  ComparisonProjectSummarySourceProject,
} from './comparisonProjectScopeTypes.ts'

const summaryPromptLabel = 'Overall decision'

const getSourceProjectContentVariants = (
  contentVariants: ComparisonProjectContentVariant[],
  sourceProject: Pick<
    ComparisonProjectLinkedSourceProject,
    'fullTextStrategyId' | 'systemPromptVariant' | 'useMetadata'
  >,
) => {
  return contentVariants.filter((contentVariant) => {
    return (
      contentVariant.systemPromptVariant === sourceProject.systemPromptVariant
      && contentVariant.useMetadata === sourceProject.useMetadata
      && contentVariant.fullTextStrategyId === sourceProject.fullTextStrategyId
    )
  })
}

export const getComparisonProjectColumns = (
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
        const sourceProjectContentVariants = getSourceProjectContentVariants(contentVariants, sourceProject)

        return modelRow
          ? sourceProjectContentVariants.map<ComparisonProjectJudgmentsColumn>((contentVariant) => {
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
