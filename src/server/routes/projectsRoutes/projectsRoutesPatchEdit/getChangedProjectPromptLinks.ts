import type {
  ChangedProjectPromptLink,
  ExistingProjectPromptAssociation,
  ResolvedProjectPromptEdit,
} from './projectEditTypes.ts'

export const getChangedProjectPromptLinks = ({
  removedAssociations,
  resolvedPromptEdits,
}: {
  removedAssociations: ExistingProjectPromptAssociation[]
  resolvedPromptEdits: ResolvedProjectPromptEdit[]
}) => {
  const finalTargetPromptIds = new Set(
    resolvedPromptEdits.map((promptEdit) => {
      return promptEdit.targetPromptId
    }),
  )
  const replacedLinks = resolvedPromptEdits.flatMap((promptEdit): ChangedProjectPromptLink[] => {
    return promptEdit.shouldDeleteOriginalAssociation
      && promptEdit.originalId
      && promptEdit.currentAssociation
      && !finalTargetPromptIds.has(promptEdit.originalId)
      ? [
          {
            newPromptId: promptEdit.targetPromptId,
            oldPromptId: promptEdit.originalId,
            projectPromptId: promptEdit.currentAssociation.id,
            reason: 'replaced',
          },
        ]
      : []
  })
  const removedLinks = removedAssociations.map((entry): ChangedProjectPromptLink => {
    return {newPromptId: null, oldPromptId: entry.promptId, projectPromptId: entry.id, reason: 'removed'}
  })

  return [...replacedLinks, ...removedLinks]
}
