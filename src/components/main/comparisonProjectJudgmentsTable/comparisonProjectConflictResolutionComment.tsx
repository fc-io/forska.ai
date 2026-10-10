import {createSignal, Show, splitProps} from 'solid-js'

import type {ComparisonProjectConflictResolutionValue} from '../../../services/comparisonProjectsService.ts'
import {cn} from '../../../utils/cn.ts'
import {comparisonProjectConflictResolutionCommentMaxLength} from '../../../utils/comparisonProjectConflictResolutionComment.ts'
import {Popover, PopoverContent, PopoverTrigger} from '../../ui/popover.tsx'
import {
  getConflictResolutionCommentButtonLabel,
  getConflictResolutionCommentButtonTitle,
  getHasUnsavedConflictResolutionCommentDraft,
  getIsConflictResolutionCommentSaveShortcut,
  getNormalizedConflictResolutionComment,
  getSavedConflictResolutionComment,
} from './comparisonProjectConflictResolutionComment/comparisonProjectConflictResolutionCommentText.ts'

export type ComparisonProjectConflictResolutionCommentSaveResult = boolean | undefined

type ComparisonProjectConflictResolutionCommentProps = {
  articleTitle: string
  disabled: boolean
  draft: string | null
  onDraftChange?: (draft: string | null) => void
  onSave?: (
    comment: string | null,
  ) =>
    | ComparisonProjectConflictResolutionCommentSaveResult
    | Promise<ComparisonProjectConflictResolutionCommentSaveResult>
  resolution: ComparisonProjectConflictResolutionValue | null
}

const secondaryButtonClass =
  'rounded border border-gray-300 bg-white px-2 py-0.5 text-xs text-gray-700 shadow-sm hover:bg-gray-100 disabled:opacity-60'

export const ComparisonProjectConflictResolutionComment = (props: ComparisonProjectConflictResolutionCommentProps) => {
  const [local] = splitProps(props, ['articleTitle', 'disabled', 'draft', 'onDraftChange', 'onSave', 'resolution'])
  const [isOpen, setIsOpen] = createSignal(false)
  const [isSaving, setIsSaving] = createSignal(false)
  let textareaRef: HTMLTextAreaElement | undefined

  const savedComment = () => {
    return getSavedConflictResolutionComment(local.resolution)
  }
  const hasComment = () => {
    return savedComment() !== null
  }
  const hasUnsavedDraft = () => {
    return getHasUnsavedConflictResolutionCommentDraft(local.draft, local.resolution)
  }
  const editorText = () => {
    return local.draft ?? savedComment() ?? ''
  }
  const areControlsDisabled = () => {
    return local.disabled || isSaving() || !local.resolution
  }
  const updateDraft = (value: string) => {
    local.onDraftChange?.(value === (savedComment() ?? '') ? null : value)
  }
  const discardDraft = () => {
    local.onDraftChange?.(null)
    setIsOpen(false)
  }
  const saveComment = async (comment: string | null) => {
    setIsSaving(true)
    const isSaved =
      (await Promise.resolve(local.onSave?.(comment)).catch(() => {
        return false
      })) !== false
    setIsSaving(false)

    if (isSaved) {
      discardDraft()
    } else {
      textareaRef?.focus()
    }
  }
  const saveEditorText = () => {
    const comment = getNormalizedConflictResolutionComment(editorText())

    if (comment === savedComment()) {
      discardDraft()
    } else {
      void saveComment(comment)
    }
  }

  return (
    <Popover open={isOpen()} onOpenChange={setIsOpen} placement="bottom-end">
      <PopoverTrigger
        type="button"
        class={cn(
          'relative inline-flex size-6 shrink-0 items-center justify-center rounded border border-gray-300 bg-white text-gray-600 shadow-sm hover:border-gray-400 hover:bg-gray-100 hover:text-gray-900 disabled:opacity-60',
          hasComment() && 'border-blue-300 bg-blue-50 text-blue-700 hover:border-blue-400 hover:bg-blue-100',
        )}
        title={getConflictResolutionCommentButtonTitle(local.resolution, hasUnsavedDraft())}
        aria-label={getConflictResolutionCommentButtonLabel(hasComment(), local.articleTitle)}
        data-has-comment={hasComment() ? 'true' : 'false'}
        data-has-draft={hasUnsavedDraft() ? 'true' : 'false'}
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
        <Show when={hasUnsavedDraft()}>
          <span class="absolute -right-1 -top-1 size-2 rounded-full bg-amber-500 ring-1 ring-white" />
        </Show>
      </PopoverTrigger>
      <PopoverContent
        class="space-y-2"
        aria-label={`Comment on the conflict resolution for ${local.articleTitle}`}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          textareaRef?.focus()
          textareaRef?.setSelectionRange(editorText().length, editorText().length)
        }}
      >
        <textarea
          ref={textareaRef}
          autofocus
          rows={4}
          maxlength={comparisonProjectConflictResolutionCommentMaxLength}
          value={editorText()}
          disabled={areControlsDisabled()}
          aria-label={`Comment for ${local.articleTitle}`}
          placeholder="Why this resolution?"
          class="block w-full resize-y rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-gray-900 shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          onInput={(event) => {
            updateDraft(event.currentTarget.value)
          }}
          onKeyDown={(event) => {
            if (getIsConflictResolutionCommentSaveShortcut(event) && !areControlsDisabled()) {
              event.preventDefault()
              saveEditorText()
            }
          }}
        />
        <div class="flex items-center justify-between gap-2">
          <span class="text-[11px] text-gray-500">
            {editorText().length} / {comparisonProjectConflictResolutionCommentMaxLength}
          </span>
          <div class="flex items-center gap-1.5">
            <button
              type="button"
              class={secondaryButtonClass}
              disabled={areControlsDisabled() || local.draft === null}
              title="Drop the unsaved text and keep the saved comment"
              onClick={discardDraft}
            >
              Discard
            </button>
            <button
              type="button"
              class={secondaryButtonClass}
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
              onClick={saveEditorText}
            >
              Save
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
