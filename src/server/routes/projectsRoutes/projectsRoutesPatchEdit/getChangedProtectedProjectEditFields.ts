import type {SystemPromptVariant} from '../../../../agent/judge/systemPromptVariant.ts'
import type {FullTextChunkPolicy, FullTextFigureMode} from '../../../fullText/fullTextStrategy.ts'
import {getProjectFullTextValues} from '../projectFullTextSettings.ts'
import {getProjectUsesFullText} from './getProjectUsesFullText.ts'
import {hasDateEditChanged} from './hasDateEditChanged.ts'
import {hasSameStringSet} from './hasSameStringSet.ts'
import {hasSystemPromptVariantEditChanged} from './hasSystemPromptVariantEditChanged.ts'
import type {ProjectEditCurrentProject} from './projectEditTypes.ts'

export const getChangedProtectedProjectEditFields = ({
  body,
  currentImportRoutes,
  currentProject,
  parsedDateFrom,
  parsedDateTo,
}: {
  body: {
    dateFrom?: string | null
    dateTo?: string | null
    humanJudgmentMode?: 'prompt' | 'summary'
    importRoutes?: string[]
    modelId?: string
    systemPromptVariant?: SystemPromptVariant
    useAbstract?: boolean
    useFulltext?: boolean
    useMetadata?: boolean
    useTitle?: boolean
    fullTextFigureMode?: FullTextFigureMode | null
    fullTextChunkPolicy?: FullTextChunkPolicy | null
  }
  currentImportRoutes: string[]
  currentProject: ProjectEditCurrentProject
  parsedDateFrom: Date | null | undefined
  parsedDateTo: Date | null | undefined
}) => {
  return [
    body.modelId !== undefined && body.modelId !== currentProject.modelId ? 'modelId' : null,
    hasSystemPromptVariantEditChanged(body.systemPromptVariant, currentProject) ? 'systemPromptVariant' : null,
    body.useTitle !== undefined && body.useTitle !== currentProject.useTitle ? 'useTitle' : null,
    body.useAbstract !== undefined && body.useAbstract !== currentProject.useAbstract ? 'useAbstract' : null,
    body.useFulltext !== undefined && body.useFulltext !== getProjectUsesFullText(currentProject)
      ? 'useFulltext'
      : null,
    body.useMetadata !== undefined && body.useMetadata !== currentProject.useMetadata ? 'useMetadata' : null,
    body.fullTextFigureMode !== undefined
    && body.fullTextFigureMode !== getProjectFullTextValues(currentProject).fullTextFigureMode
      ? 'fullTextFigureMode'
      : null,
    body.fullTextChunkPolicy !== undefined
    && JSON.stringify(body.fullTextChunkPolicy)
      !== JSON.stringify(getProjectFullTextValues(currentProject).fullTextChunkPolicy)
      ? 'fullTextChunkPolicy'
      : null,
    body.humanJudgmentMode !== undefined && body.humanJudgmentMode !== (currentProject.humanJudgmentMode ?? 'prompt')
      ? 'humanJudgmentMode'
      : null,
    hasDateEditChanged(parsedDateFrom, currentProject.dateFrom) ? 'dateFrom' : null,
    hasDateEditChanged(parsedDateTo, currentProject.dateTo) ? 'dateTo' : null,
    body.importRoutes !== undefined && !hasSameStringSet(body.importRoutes, currentImportRoutes)
      ? 'importRoutes'
      : null,
  ].filter((field): field is string => {
    return field !== null
  })
}
