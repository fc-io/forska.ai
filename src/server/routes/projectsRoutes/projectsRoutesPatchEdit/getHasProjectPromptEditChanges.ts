import {getPromptMetadataValue} from './getPromptMetadataValue.ts'
import type {ExistingProjectPromptComparisonRow, ProjectEditPromptPayload} from './projectEditTypes.ts'

const getEffectiveSubmittedPromptEdits = (
  submittedPrompts: ProjectEditPromptPayload[],
  existingPromptIds: Set<string>,
) => {
  return submittedPrompts
    .filter((prompt) => {
      return (prompt.originalText ?? '').trim() !== ''
    })
    .filter((prompt) => {
      return !prompt.originalId || existingPromptIds.has(prompt.originalId) || prompt.enabled === true
    })
}

export const getHasProjectPromptEditChanges = ({
  existingPrompts,
  submittedPrompts,
}: {
  existingPrompts: ExistingProjectPromptComparisonRow[]
  submittedPrompts: ProjectEditPromptPayload[] | undefined
}) => {
  if (submittedPrompts === undefined) {
    return false
  }

  const existingByPromptId = new Map(
    existingPrompts.map((prompt) => {
      return [prompt.promptId, prompt]
    }),
  )
  const existingPromptIds = new Set(
    existingPrompts.map((prompt) => {
      return prompt.promptId
    }),
  )
  const effectiveSubmittedPrompts = getEffectiveSubmittedPromptEdits(submittedPrompts, existingPromptIds)
  const receivedOriginalIds = new Set(
    effectiveSubmittedPrompts
      .map((prompt) => {
        return prompt.originalId
      })
      .filter((id): id is string => {
        return typeof id === 'string'
      }),
  )
  const hasRemovedPrompt = existingPrompts.some((prompt) => {
    return !receivedOriginalIds.has(prompt.promptId)
  })

  return (
    hasRemovedPrompt
    || effectiveSubmittedPrompts.some((prompt) => {
      if (!prompt.originalId) {
        return true
      }

      const existingPrompt = existingByPromptId.get(prompt.originalId)
      if (!existingPrompt) {
        return true
      }

      const existingPromptHeading = getPromptMetadataValue(existingPrompt.promptHeading) ?? null
      const existingPromptType = getPromptMetadataValue(existingPrompt.type) ?? null
      const promptHeading = getPromptMetadataValue(prompt.promptHeading)
      const promptType = getPromptMetadataValue(prompt.type)
      const targetPromptHeading = promptHeading === undefined ? existingPromptHeading : promptHeading
      const targetPromptType = promptType === undefined ? existingPromptType : promptType
      const hasArchivedChange = typeof prompt.archived === 'boolean' && prompt.archived !== existingPrompt.archived
      const hasEnabledChange = typeof prompt.enabled === 'boolean' && prompt.enabled !== existingPrompt.enabled

      return (
        prompt.originalText !== existingPrompt.originalText
        || targetPromptHeading !== existingPromptHeading
        || targetPromptType !== existingPromptType
        || prompt.order !== existingPrompt.order
        || hasArchivedChange
        || hasEnabledChange
      )
    })
  )
}
