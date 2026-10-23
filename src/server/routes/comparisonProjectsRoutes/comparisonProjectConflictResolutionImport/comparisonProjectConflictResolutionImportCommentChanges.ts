import type {
  ComparisonProjectConflictResolutionImportCommentChange,
  ComparisonProjectConflictResolutionImportCommentChangeKind,
  ComparisonProjectConflictResolutionImportCommentSource,
  ComparisonProjectConflictResolutionImportOverwriteMode,
} from './comparisonProjectConflictResolutionImportTypes.ts'

const getCommentChangeKind = (params: {
  comment: string
  existingComment: string | null
  overwriteMode: ComparisonProjectConflictResolutionImportOverwriteMode
}): ComparisonProjectConflictResolutionImportCommentChangeKind | null => {
  return params.existingComment === null
    ? 'add'
    : params.existingComment === params.comment
      ? null
      : params.overwriteMode === 'overwrite-different'
        ? 'replace'
        : 'keep'
}

export const getComparisonProjectConflictResolutionImportCommentChanges = (params: {
  commentSources: readonly ComparisonProjectConflictResolutionImportCommentSource[]
  existingCommentsByArticleId: ReadonlyMap<string, string>
  overwriteMode: ComparisonProjectConflictResolutionImportOverwriteMode
}): ComparisonProjectConflictResolutionImportCommentChange[] => {
  return params.commentSources.flatMap((commentSource) => {
    const change = getCommentChangeKind({
      comment: commentSource.comment,
      existingComment: params.existingCommentsByArticleId.get(commentSource.targetArticleId) ?? null,
      overwriteMode: params.overwriteMode,
    })

    return change ? [{...commentSource, change}] : []
  })
}

const getCommentChangeCount = (
  commentChanges: readonly ComparisonProjectConflictResolutionImportCommentChange[],
  change: ComparisonProjectConflictResolutionImportCommentChangeKind,
) => {
  return commentChanges.filter((commentChange) => {
    return commentChange.change === change
  }).length
}

export const getComparisonProjectConflictResolutionImportCommentChangeCounts = (
  commentChanges: readonly ComparisonProjectConflictResolutionImportCommentChange[],
) => {
  return {
    commentsAdded: getCommentChangeCount(commentChanges, 'add'),
    commentsKept: getCommentChangeCount(commentChanges, 'keep'),
    commentsReplaced: getCommentChangeCount(commentChanges, 'replace'),
  }
}
