const includeExcludePromptTypePattern = /^\s*(['"])(include|exclude)\1\s*\|\s*(['"])(include|exclude)\3\s*$/

export const isIncludeExcludePromptType = (promptType: string | null | undefined): boolean => {
  const match = includeExcludePromptTypePattern.exec(promptType ?? '')

  return match !== null && match[2] !== match[4]
}
