export const getDuplicateTargetPromptIds = (targetPromptIds: string[]) => {
  const duplicateState = targetPromptIds.reduce(
    (state, targetPromptId) => {
      if (state.seenTargetPromptIds.has(targetPromptId)) {
        state.duplicateTargetPromptIds.add(targetPromptId)
      }
      state.seenTargetPromptIds.add(targetPromptId)
      return state
    },
    {duplicateTargetPromptIds: new Set<string>(), seenTargetPromptIds: new Set<string>()},
  )

  return Array.from(duplicateState.duplicateTargetPromptIds)
}
