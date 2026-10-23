import {getSystemPromptVariant, type SystemPromptVariant} from '../../../../agent/judge/systemPromptVariant.ts'
import type {ProjectEditCurrentProject} from './projectEditTypes.ts'

export const hasSystemPromptVariantEditChanged = (
  systemPromptVariant: SystemPromptVariant | undefined,
  currentProject: Pick<ProjectEditCurrentProject, 'systemPromptVariant'>,
) => {
  return (
    systemPromptVariant !== undefined
    && systemPromptVariant !== getSystemPromptVariant(currentProject.systemPromptVariant)
  )
}
