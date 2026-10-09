export type DuplicateGroupPrompt = {id: string}

export const getDuplicateGroupKey = (group: readonly DuplicateGroupPrompt[]): string => {
  return group
    .map((prompt) => {
      return prompt.id
    })
    .sort()
    .join('|')
}

export const getMergePromptIds = (
  group: readonly DuplicateGroupPrompt[],
  keepId: string | undefined,
): string[] | null => {
  const keepIsInGroup = group.some((prompt) => {
    return prompt.id === keepId
  })

  return keepIsInGroup
    ? group
        .filter((prompt) => {
          return prompt.id !== keepId
        })
        .map((prompt) => {
          return prompt.id
        })
    : null
}
