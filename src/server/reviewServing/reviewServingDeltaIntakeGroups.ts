import {reviewServingDirtyWorkBatchChunkSize} from './reviewServingDirtyWorkService.ts'

export const reviewServingDeltaIntakeMaxDirtyWorkPerTransaction = reviewServingDirtyWorkBatchChunkSize

type DeltaIntakeRun<T> = {deltaId: string; dirtyWorkCount: number; entries: T[]}
type DeltaIntakeGroupState<T> = {groupDirtyWorkCount: number; groups: T[][]}

type RunReviewServingDeltaIntakeGroupsInput<T> = {
  deadlineAtMs?: number | null
  groups: readonly (readonly T[])[]
  nowMs?: () => number
  runGroup: (group: readonly T[]) => Promise<number>
}

type ReviewServingDeltaIntakeGroupsResult = {committedGroupCount: number; dirtyWorkCount: number}

type GetReviewServingDeltaIntakeGroupsInput<T> = {
  entries: readonly T[]
  getDeltaId: (entry: T) => string
  getDirtyWorkCount: (entry: T) => number
  maxDirtyWorkPerGroup?: number
}

const getDeltaIntakeRuns = <T>(input: GetReviewServingDeltaIntakeGroupsInput<T>) => {
  return input.entries.reduce<DeltaIntakeRun<T>[]>((runs, entry) => {
    const deltaId = input.getDeltaId(entry)
    const currentRun = runs.at(-1)
    const run = currentRun?.deltaId === deltaId ? currentRun : {deltaId, dirtyWorkCount: 0, entries: []}

    run.dirtyWorkCount += input.getDirtyWorkCount(entry)
    run.entries.push(entry)

    return run === currentRun ? runs : [...runs, run]
  }, [])
}

export const getReviewServingDeltaIntakeGroups = <T>(input: GetReviewServingDeltaIntakeGroupsInput<T>) => {
  const maxDirtyWorkPerGroup = Math.max(
    1,
    Math.floor(input.maxDirtyWorkPerGroup ?? reviewServingDeltaIntakeMaxDirtyWorkPerTransaction),
  )

  return getDeltaIntakeRuns(input).reduce<DeltaIntakeGroupState<T>>(
    (state, run) => {
      const currentGroup = state.groups.at(-1)
      const joinsCurrentGroup =
        currentGroup !== undefined && state.groupDirtyWorkCount + run.dirtyWorkCount <= maxDirtyWorkPerGroup
      const targetGroup = joinsCurrentGroup ? currentGroup : []

      targetGroup.push(...run.entries)

      return {
        groupDirtyWorkCount: (joinsCurrentGroup ? state.groupDirtyWorkCount : 0) + run.dirtyWorkCount,
        groups: joinsCurrentGroup ? state.groups : [...state.groups, targetGroup],
      }
    },
    {groupDirtyWorkCount: 0, groups: []},
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
