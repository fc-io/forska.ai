import {format} from 'date-fns'

import type {ComparisonProjectConflictResolutionValue} from '../../../../services/comparisonProjectsService.ts'

export const getSavedConflictResolutionComment = (resolution: ComparisonProjectConflictResolutionValue | null) => {
  const comment: unknown = resolution?.comment

  return typeof comment === 'string' ? comment.trim() || null : null
}

export const getNormalizedConflictResolutionComment = (value: string) => {
  return value.trim() || null
}

export const getHasUnsavedConflictResolutionCommentDraft = (
  draft: string | null,
  resolution: ComparisonProjectConflictResolutionValue | null,
) => {
  return (
    draft !== null && getNormalizedConflictResolutionComment(draft) !== getSavedConflictResolutionComment(resolution)
  )
}

const getCommentSetLabel = (resolution: ComparisonProjectConflictResolutionValue) => {
  const updatedAt = resolution.commentUpdatedAt ? new Date(resolution.commentUpdatedAt) : null

  return updatedAt && !Number.isNaN(updatedAt.getTime()) ? `Comment set ${format(updatedAt, 'yyyy-MM-dd HH:mm')}` : null
}

const getResolvedCommentButtonTitle = (
  resolution: ComparisonProjectConflictResolutionValue,
  hasUnsavedDraft: boolean,
) => {
  const savedComment = getSavedConflictResolutionComment(resolution)

  return [
    savedComment ?? 'Add comment',
    savedComment ? getCommentSetLabel(resolution) : null,
    hasUnsavedDraft ? 'Unsaved draft' : null,
  ]
    .filter((line) => {
      return line !== null
    })
    .join('\n')
}

export const getConflictResolutionCommentButtonTitle = (
  resolution: ComparisonProjectConflictResolutionValue | null,
  hasUnsavedDraft: boolean,
) => {
  return resolution ? getResolvedCommentButtonTitle(resolution, hasUnsavedDraft) : 'Set a resolution first'
}

export const getConflictResolutionCommentButtonLabel = (hasComment: boolean, articleTitle: string) => {
  return `${hasComment ? 'Edit' : 'Add'} comment on the conflict resolution for ${articleTitle}`
}

export const getIsConflictResolutionCommentSaveShortcut = (event: KeyboardEvent) => {
  return event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing
}
