import {newProjectSystemPromptVariant, type SystemPromptVariant} from '../../../../agent/judge/systemPromptVariant.ts'
import type {ProjectBound} from './subprojectTypes.ts'

export const getSubprojectSystemPromptVariant = (projectBounds: ProjectBound[]): SystemPromptVariant => {
  const sourceSystemPromptVariants = new Set(
    projectBounds.map((project) => {
      return project.systemPromptVariant
    }),
  )
  const [sourceSystemPromptVariant] = sourceSystemPromptVariants

  return sourceSystemPromptVariants.size === 1 && sourceSystemPromptVariant
    ? sourceSystemPromptVariant
    : newProjectSystemPromptVariant
}
