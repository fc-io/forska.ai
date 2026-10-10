import {createSignal, splitProps} from 'solid-js'

import type {ComparisonProjectConflictResolutionValue} from '../../../services/comparisonProjectsService.ts'
import {cn} from '../../../utils/cn.ts'
import {comparisonProjectConflictResolutionCommentMaxLength} from '../../../utils/comparisonProjectConflictResolutionComment.ts'
import {Popover, PopoverContent, PopoverTrigger} from '../../ui/popover.tsx'

export type ComparisonProjectConflictResolutionCommentSaveResult = boolean | undefined

type ComparisonProjectConflictResolutionCommentProps = {
  articleTitle: string
  disabled: boolean
  onSave?: (
    comment: string | null,
  ) =>
    | ComparisonProjectConflictResolutionCommentSaveResult
    | Promise<ComparisonProjectConflictResolutionCommentSaveResult>
  resolution: ComparisonProjectConflictResolutionValue | null
}

const getSavedComment = (resolution: ComparisonProjectConflictResolutionValue | null) => {
  return resolution?.comment?.trim() || null
}

const getNormalizedComment = (value: string) => {
  return value.trim() || null
}

const getCommentButtonTitle = (resolution: ComparisonProjectConflictResolutionValue | null) => {
  return resolution ? (getSavedComment(resolution) ?? 'Add comment') : 'Set a resolution first'
}

const getCommentButtonLabel = (hasComment: boolean, articleTitle: string) => {
  return `${hasComment ? 'Edit' : 'Add'} comment on the conflict resolution for ${articleTitle}`
}

const getIsSaveShortcut = (event: KeyboardEvent) => {
  return event.key === 'Enter' && (event.metaKey || event.ctrlKey)
}

export const ComparisonProjectConflictResolutionComment = (props: ComparisonProjectConflictResolutionCommentProps) => {
  const [local] = splitProps(props, ['articleTitle', 'disabled', 'onSave', 'resolution'])
  const [isOpen, setIsOpen] = createSignal(false)
  const [isSaving, setIsSaving] = createSignal(false)
  const [draft, setDraft] = createSignal('')
  let textareaRef: HTMLTextAreaElement | undefined

  const hasComment = () => {
    return getSavedComment(local.resolution) !== null
  }
  const areControlsDisabled = () => {
    return local.disabled || isSaving() || !local.resolution
  }
  const handleOpenChange = (open: boolean) => {
    setDraft(local.resolution?.comment ?? '')
    setIsOpen(open)
  }
  const saveComment = async (comment: string | null) => {
    setIsSaving(true)
    const result = await Promise.resolve(local.onSave?.(comment)).catch(() => {
      return false
    })
    setIsSaving(false)
    setIsOpen(result === false)
  }
  const saveDraft = () => {
    const comment = getNormalizedComment(draft())

    if (comment === getSavedComment(local.resolution)) {
      setIsOpen(false)
    } else {
      void saveComment(comment)
    }
  }

  return (
    <Popover open={isOpen()} onOpenChange={handleOpenChange} placement="bottom-end">
      <PopoverTrigger
        type="button"
        class={cn(
          'inline-flex size-6 shrink-0 items-center justify-center rounded border border-gray-300 bg-white text-gray-600 shadow-sm hover:border-gray-400 hover:bg-gray-100 hover:text-gray-900 disabled:opacity-60',
          hasComment() && 'border-blue-300 bg-blue-50 text-blue-700 hover:border-blue-400 hover:bg-blue-100',
        )}
        title={getCommentButtonTitle(local.resolution)}
        aria-label={getCommentButtonLabel(hasComment(), local.articleTitle)}
        data-has-comment={hasComment() ? 'true' : 'false'}
        disabled={local.disabled || !local.resolution}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill={hasComment() ? 'currentColor' : 'none'}
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="size-3.5"
        >
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </PopoverTrigger>
      <PopoverContent
        class="space-y-2"
        aria-label={`Comment on the conflict resolution for ${local.articleTitle}`}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          textareaRef?.focus()
          textareaRef?.setSelectionRange(draft().length, draft().length)
        }}
      >
        <textarea
          ref={textareaRef}
          autofocus
          rows={4}
          maxlength={comparisonProjectConflictResolutionCommentMaxLength}
          value={draft()}
          disabled={areControlsDisabled()}
          aria-label={`Comment for ${local.articleTitle}`}
          placeholder="Why this resolution?"
          class="block w-full resize-y rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-gray-900 shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          onInput={(event) => {
            setDraft(event.currentTarget.value)
          }}
          onKeyDown={(event) => {
            if (getIsSaveShortcut(event) && !areControlsDisabled()) {
              event.preventDefault()
              saveDraft()
            }
          }}
        />
        <div class="flex items-center justify-between gap-2">
          <span class="text-[11px] text-gray-500">
            {draft().length} / {comparisonProjectConflictResolutionCommentMaxLength}
          </span>
          <div class="flex items-center gap-1.5">
            <button
              type="button"
              class="rounded border border-gray-300 bg-white px-2 py-0.5 text-xs text-gray-700 shadow-sm hover:bg-gray-100 disabled:opacity-60"
              disabled={areControlsDisabled() || !hasComment()}
              onClick={() => {
                void saveComment(null)
              }}
            >
              Remove
            </button>
            <button
              type="button"
              class="rounded border border-blue-600 bg-blue-600 px-2 py-0.5 text-xs font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-60"
              disabled={areControlsDisabled()}
              title="Save (Cmd/Ctrl+Enter)"
              onClick={saveDraft}
            >
              Save
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
