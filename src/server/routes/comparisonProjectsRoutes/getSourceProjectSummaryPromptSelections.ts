import type {ProjectPromptCriteriaDisposition} from '../../../db/schemaTypes.ts'
import type {ComparisonProjectSource, PromptSelection} from './comparisonProjectRouteTypes.ts'

const hasSummaryPromptCriteriaMetadata = (prompt: {
  criteriaDisposition: ProjectPromptCriteriaDisposition | null
  criteriaSectionKey: string | null
}) => {
  return Boolean(prompt.criteriaDisposition && prompt.criteriaSectionKey)
}

export const getSourceProjectSummaryPromptSelections = (sourceProject: ComparisonProjectSource) => {
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
