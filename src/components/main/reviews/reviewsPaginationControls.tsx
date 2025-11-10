import type {Accessor, Setter} from 'solid-js'
import {createEffect, createMemo, Show} from 'solid-js'

interface ReviewsPaginationControlsProps {
  page: number
  totalPages: number
  setCurrentPage: Setter<number>
  currentPageRowIds?: string[]
  rowSelection?: Accessor<Record<string, boolean>>
  setRowSelection?: Setter<Record<string, boolean>>
}

export const ReviewsPaginationControls = (props: ReviewsPaginationControlsProps) => {
  const handlePageChange = (newPage: number) => {
    props.setCurrentPage(newPage)
  }

  const allSelected = createMemo(() => {
    if (!props.currentPageRowIds || !props.rowSelection) return false
    const sel = props.rowSelection()
    return (
      props.currentPageRowIds.length > 0
      && props.currentPageRowIds.every((id) => {
        return Boolean(sel[id])
      })
    )
  })

  const someSelected = createMemo(() => {
    if (!props.currentPageRowIds || !props.rowSelection) return false
    const sel = props.rowSelection()
    const hasAny = props.currentPageRowIds.some((id) => {
      return Boolean(sel[id])
    })
    return hasAny && !allSelected()
  })

  let selectAllEl: HTMLInputElement | undefined
  createEffect(() => {
    if (selectAllEl) {
      selectAllEl.indeterminate = someSelected()
    }
  })

  const toggleSelectAll = (checked: boolean) => {
    if (!props.setRowSelection || !props.currentPageRowIds) return
    props.setRowSelection((prev) => {
      const next: Record<string, boolean> = {...(prev || {})}
      if (checked) {
        for (const id of props.currentPageRowIds || []) {
          next[id] = true
        }
      } else {
        for (const id of props.currentPageRowIds || []) {
          if (id in next) delete next[id]
        }
      }
      return next
    })
  }

  const selectedCount = createMemo(() => {
    if (!props.currentPageRowIds || !props.rowSelection) return 0
    const sel = props.rowSelection()
    return props.currentPageRowIds.reduce((acc, id) => {
      return acc + (sel[id] ? 1 : 0)
    }, 0)
  })

  return (
    <>
      <div class="flex items-center justify-between gap-2 p-2 bg-white rounded-lg shadow">
        <div class="flex items-center gap-2">
          <Show when={props.currentPageRowIds && props.rowSelection && props.setRowSelection}>
            <div class="flex items-center gap-2">
              <input
                ref={selectAllEl}
                type="checkbox"
                class="w-[15px] h-[15px]"
                checked={allSelected()}
                onChange={(e) => {
                  toggleSelectAll(Boolean(e.currentTarget.checked))
                }}
              />
              <label class="text-xs text-gray-700">Select all rows</label>
            </div>
          </Show>
        </div>

        <div class="flex items-center justify-center gap-1">
          <button
            class="px-2 py-1 text-xs font-medium text-gray-700 bg-gray-100 border border-gray-300 rounded hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={props.page <= 1}
            onClick={() => {
              return handlePageChange(props.page - 1)
            }}
          >
            Previous
          </button>

          <span class="mx-2 text-xs text-gray-700">
            Page {props.page} of {props.totalPages}
          </span>

          <button
            class="px-2 py-1 text-xs font-medium text-gray-700 bg-gray-100 border border-gray-300 rounded hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={props.page >= props.totalPages}
            onClick={() => {
              return handlePageChange(props.page + 1)
            }}
          >
            Next
          </button>
        </div>

        <div class="flex items-center gap-1">
          <label class="text-xs text-gray-700">Go to page:</label>
          <input
            type="number"
            min="1"
            max={props.totalPages}
            value={props.page}
            class="w-12 px-1 py-0.5 text-xs border rounded"
            onInput={(e) => {
              const newPage = parseInt(e.target.value)
              if (newPage >= 1 && newPage <= props.totalPages) {
                handlePageChange(newPage)
              }
            }}
          />
        </div>
      </div>
      <Show when={allSelected()}>
        <div class="mt-2 text-xs text-gray-700 p-2 bg-white rounded-lg shadow">{selectedCount()} rows selected</div>
      </Show>
    </>
  )
}
