import type {
  ComparisonProjectConflictResolutionImportCommentChange,
  ComparisonProjectConflictResolutionImportCommentChangeKind,
} from './comparisonProjectConflictResolutionImportTypes.ts'

export type CommentChangeBySourceRowId = ReadonlyMap<string, ComparisonProjectConflictResolutionImportCommentChangeKind>

export const getCommentChangeBySourceRowId = (
  commentChanges: readonly ComparisonProjectConflictResolutionImportCommentChange[],
): CommentChangeBySourceRowId => {
  return new Map(
    commentChanges.map((commentChange) => {
      return [commentChange.sourceRowId, commentChange.change] as const
    }),
  )
}
