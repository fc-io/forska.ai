import {format} from 'date-fns'

import type {ComparisonProjectConflictCommentValue} from '../../../../services/comparisonProjectsService.ts'

export const getSavedConflictComment = (conflictComment: ComparisonProjectConflictCommentValue | null) => {
  const comment: unknown = conflictComment?.comment

  return typeof comment === 'string' ? comment.trim() || null : null
}

export const getNormalizedConflictComment = (value: string) => {
  return value.trim() || null
}

export const getHasUnsavedConflictCommentDraft = (
  draft: string | null,
  conflictComment: ComparisonProjectConflictCommentValue | null,
) => {
  return draft !== null && getNormalizedConflictComment(draft) !== getSavedConflictComment(conflictComment)
}

const getConflictCommentUpdatedAtLabel = (conflictComment: ComparisonProjectConflictCommentValue) => {
  const updatedAt = conflictComment.updatedAt ? new Date(conflictComment.updatedAt) : null

  return updatedAt && !Number.isNaN(updatedAt.getTime()) ? format(updatedAt, 'yyyy-MM-dd HH:mm') : null
}

const getConflictCommentAuthorName = (conflictComment: ComparisonProjectConflictCommentValue) => {
  const displayName: unknown = conflictComment.author?.displayName

  return typeof displayName === 'string' ? displayName.trim() || null : null
}

export const getConflictCommentAttributionLabel = (conflictComment: ComparisonProjectConflictCommentValue) => {
  const authorName = getConflictCommentAuthorName(conflictComment)
  const updatedAtLabel = getConflictCommentUpdatedAtLabel(conflictComment)

  return authorName || updatedAtLabel
    ? [authorName ? `Comment by ${authorName}` : 'Comment', updatedAtLabel].filter(Boolean).join(', ')
    : null
}

export const getConflictCommentButtonTitle = (
  conflictComment: ComparisonProjectConflictCommentValue | null,
  hasUnsavedDraft: boolean,
) => {
  const savedComment = getSavedConflictComment(conflictComment)

  return [
    savedComment ?? 'Add comment',
    savedComment && conflictComment ? getConflictCommentAttributionLabel(conflictComment) : null,
    hasUnsavedDraft ? 'Unsaved draft' : null,
  ]
    .filter((line) => {
      return line !== null
    })
    .join('\n')
}

export const getConflictCommentButtonLabel = (hasComment: boolean, articleTitle: string) => {
  return `${hasComment ? 'Edit' : 'Add'} comment on the conflict for ${articleTitle}`
}

export const getIsConflictCommentSaveShortcut = (event: KeyboardEvent) => {
  return event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing
}
