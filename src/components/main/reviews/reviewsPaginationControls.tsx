import type {Setter} from 'solid-js'

interface ReviewsPaginationControlsProps {
  page: number
  totalPages: number
  setCurrentPage: Setter<number>
}

export const ReviewsPaginationControls = (
  props: ReviewsPaginationControlsProps,
) => {
  const handlePageChange = (newPage: number) => {
    props.setCurrentPage(newPage)
  }

  return (
    <div class="flex items-center justify-center gap-1 p-2 bg-white rounded-lg shadow">
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

      <div class="ml-2 flex items-center gap-1">
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
  )
}
