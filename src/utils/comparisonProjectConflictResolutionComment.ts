export const comparisonProjectConflictResolutionCommentMaxLength = 4000

const allowedCommentControlCharacterCodes = new Set([9, 10, 13])

const getIsDisallowedCommentCharacter = (character: string) => {
  const code = character.charCodeAt(0)

  return (code < 32 && !allowedCommentControlCharacterCodes.has(code)) || code === 127
}

export const getHasComparisonProjectConflictResolutionCommentControlCharacter = (text: string) => {
  return Array.from(text).some(getIsDisallowedCommentCharacter)
}

export const removeComparisonProjectConflictResolutionCommentControlCharacters = (text: string) => {
  return Array.from(text)
    .filter((character) => {
      return !getIsDisallowedCommentCharacter(character)
    })
    .join('')
}
