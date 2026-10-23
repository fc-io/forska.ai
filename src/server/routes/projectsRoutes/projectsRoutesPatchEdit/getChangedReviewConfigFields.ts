import type {SystemPromptVariant} from '../../../../agent/judge/systemPromptVariant.ts'
import type {ProjectReviewConfigReviewServingField} from '../../../reviewServing/reviewConfigReviewServingDeltaService.ts'
import {hasDateEditChanged} from './hasDateEditChanged.ts'
import {hasSystemPromptVariantEditChanged} from './hasSystemPromptVariantEditChanged.ts'
import type {ProjectEditCurrentProject} from './projectEditTypes.ts'

export const getChangedReviewConfigFields = (params: {
  hasImportRouteChanges: boolean
  hasModelIdUpdate: boolean
  hasPromptChanges: boolean
  currentProject: ProjectEditCurrentProject
  body: {
    dateFrom?: string | null
    dateTo?: string | null
    humanJudgmentMode?: 'prompt' | 'summary'
    systemPromptVariant?: SystemPromptVariant
    useAbstract?: boolean
    useFulltext?: boolean
    useMetadata?: boolean
    useTitle?: boolean
  }
  parsedDateFrom?: Date | null
  parsedDateTo?: Date | null
}) => {
  return [
    hasDateEditChanged(params.parsedDateFrom, params.currentProject.dateFrom) ? 'dateFrom' : null,
    hasDateEditChanged(params.parsedDateTo, params.currentProject.dateTo) ? 'dateTo' : null,
    params.hasModelIdUpdate ? 'modelId' : null,
    params.hasModelIdUpdate ? 'modelExecutionIdentity' : null,
    params.body.useTitle !== undefined && params.body.useTitle !== params.currentProject.useTitle ? 'useTitle' : null,
    params.body.useAbstract !== undefined && params.body.useAbstract !== params.currentProject.useAbstract
      ? 'useAbstract'
      : null,
    params.body.useFulltext !== undefined && params.body.useFulltext !== params.currentProject.useFulltext
      ? 'useFulltext'
      : null,
    params.body.useMetadata !== undefined && params.body.useMetadata !== params.currentProject.useMetadata
      ? 'useMetadata'
      : null,
    hasSystemPromptVariantEditChanged(params.body.systemPromptVariant, params.currentProject)
      ? 'systemPromptVariant'
      : null,
    params.body.humanJudgmentMode !== undefined
    && params.body.humanJudgmentMode !== (params.currentProject.humanJudgmentMode ?? 'prompt')
      ? 'humanJudgmentMode'
      : null,
    params.hasPromptChanges ? 'promptMembership' : null,
    params.hasImportRouteChanges ? 'importRoutes' : null,
  ].filter((field): field is ProjectReviewConfigReviewServingField => {
    return field !== null
  })
}
