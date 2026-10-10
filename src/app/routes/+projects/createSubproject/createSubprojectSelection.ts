type SubprojectSourcePromptLike = {id: string}
type SubprojectSourceLike = {id: string; prompts: SubprojectSourcePromptLike[]}

type RemoveProjectPromptAnswerTypesInput = {
  projectId: string
  promptAnswerTypes: Record<string, string[]>
  selectedProjectIds: readonly string[]
  sources: readonly SubprojectSourceLike[] | undefined
}

const getPromptIdsForProjects = (
  sources: readonly SubprojectSourceLike[] | undefined,
  projectIds: readonly string[],
): Set<string> => {
  return new Set(
    (sources ?? [])
      .filter((source) => {
        return projectIds.includes(source.id)
      })
      .flatMap((source) => {
        return source.prompts.map((prompt) => {
          return prompt.id
        })
      }),
  )
}

export const getPromptAnswerTypesWithoutProject = ({
  projectId,
  promptAnswerTypes,
  selectedProjectIds,
  sources,
}: RemoveProjectPromptAnswerTypesInput): Record<string, string[]> => {
  const remainingProjectIds = selectedProjectIds.filter((selectedProjectId) => {
    return selectedProjectId !== projectId
  })
  const removedPromptIds = getPromptIdsForProjects(sources, [projectId])
  const retainedPromptIds = getPromptIdsForProjects(sources, remainingProjectIds)

  return Object.fromEntries(
    Object.entries(promptAnswerTypes).filter(([promptId]) => {
      return !removedPromptIds.has(promptId) || retainedPromptIds.has(promptId)
    }),
  )
}

const getIsoDateTime = (value: string): number | null => {
  const trimmedValue = value.trim()
  const time = trimmedValue === '' ? Number.NaN : Date.parse(`${trimmedValue}T00:00:00.000Z`)

  return Number.isNaN(time) ? null : time
}

export const getSubprojectDateRangeError = (dateFrom: string, dateTo: string): string | null => {
  const fromTime = getIsoDateTime(dateFrom)
  const toTime = getIsoDateTime(dateTo)

  return fromTime !== null && toTime !== null && fromTime > toTime
    ? 'Start date must be on or before the end date'
    : null
}
