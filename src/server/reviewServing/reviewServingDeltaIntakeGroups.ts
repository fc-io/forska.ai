export const reviewServingDeltaIntakeMaxDirtyWorkPerTransaction = 500

type DeltaIntakeGroupState<T> = {groupDirtyWorkCount: number; groups: T[][]; lastDeltaId: string | null}

type RunReviewServingDeltaIntakeGroupsInput<T> = {
  deadlineAtMs?: number | null
  groups: readonly (readonly T[])[]
  nowMs?: () => number
  runGroup: (group: readonly T[]) => Promise<number>
}

type ReviewServingDeltaIntakeGroupsResult = {committedGroupCount: number; dirtyWorkCount: number}

export const getReviewServingDeltaIntakeGroups = <T>(input: {
  entries: readonly T[]
  getDeltaId: (entry: T) => string
  getDirtyWorkCount: (entry: T) => number
  maxDirtyWorkPerGroup?: number
}) => {
  const maxDirtyWorkPerGroup = Math.max(
    1,
    Math.floor(input.maxDirtyWorkPerGroup ?? reviewServingDeltaIntakeMaxDirtyWorkPerTransaction),
  )

  return input.entries.reduce<DeltaIntakeGroupState<T>>(
    (state, entry) => {
      const deltaId = input.getDeltaId(entry)
      const dirtyWorkCount = input.getDirtyWorkCount(entry)
      const currentGroup = state.groups.at(-1)
      const joinsCurrentGroup =
        currentGroup !== undefined
        && (deltaId === state.lastDeltaId || state.groupDirtyWorkCount + dirtyWorkCount <= maxDirtyWorkPerGroup)
      const targetGroup = joinsCurrentGroup ? currentGroup : []

      targetGroup.push(entry)

      return {
        groupDirtyWorkCount: (joinsCurrentGroup ? state.groupDirtyWorkCount : 0) + dirtyWorkCount,
        groups: joinsCurrentGroup ? state.groups : [...state.groups, targetGroup],
        lastDeltaId: deltaId,
      }
    },
    {groupDirtyWorkCount: 0, groups: [], lastDeltaId: null},
  ).groups
}

const isReviewServingDeltaIntakeDeadlineReached = <T>(input: RunReviewServingDeltaIntakeGroupsInput<T>) => {
  return (
    input.deadlineAtMs !== null
    && input.deadlineAtMs !== undefined
    && (input.nowMs?.() ?? Date.now()) >= input.deadlineAtMs
  )
}

const runRemainingReviewServingDeltaIntakeGroups = async <T>(
  input: RunReviewServingDeltaIntakeGroupsInput<T>,
  result: ReviewServingDeltaIntakeGroupsResult,
): Promise<ReviewServingDeltaIntakeGroupsResult> => {
  const [group, ...remainingGroups] = input.groups
  const stopped =
    group === undefined || (result.committedGroupCount > 0 && isReviewServingDeltaIntakeDeadlineReached(input))

  return stopped
    ? result
    : runRemainingReviewServingDeltaIntakeGroups(
        {...input, groups: remainingGroups},
        {
          committedGroupCount: result.committedGroupCount + 1,
          dirtyWorkCount: result.dirtyWorkCount + (await input.runGroup(group)),
        },
      )
}

export const runReviewServingDeltaIntakeGroups = <T>(input: RunReviewServingDeltaIntakeGroupsInput<T>) => {
  return runRemainingReviewServingDeltaIntakeGroups(input, {committedGroupCount: 0, dirtyWorkCount: 0})
}
