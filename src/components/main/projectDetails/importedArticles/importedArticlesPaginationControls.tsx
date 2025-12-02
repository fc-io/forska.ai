interface ImportedArticlesPaginationControlsProps {
  page: number
  totalPages: number
  totalCount: number
  limit: number
  onPageChange: (page: number) => void
  onLimitChange: (limit: number) => void
}

export const ImportedArticlesPaginationControls = (props: ImportedArticlesPaginationControlsProps) => {
  const handlePrev = () => {
    if (props.page > 1) props.onPageChange(props.page - 1)
  }
  const handleNext = () => {
    if (props.page < props.totalPages) props.onPageChange(props.page + 1)
  }

  const start = () => {
    return props.totalCount === 0 ? 0 : (props.page - 1) * props.limit + 1
  }
  const end = () => {
    return Math.min(props.page * props.limit, props.totalCount)
  }

  return (
    <div class="flex items-center justify-between gap-2 p-3 bg-white rounded-lg shadow">
      <div class="text-sm text-gray-700">
        Showing {start()}–{end()} of {props.totalCount}
      </div>
      <div class="flex items-center gap-3">
        <button
          class="px-3 py-2 text-sm font-medium text-gray-700 bg-gray-100 border border-gray-300 rounded-md hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={props.page <= 1}
          onClick={handlePrev}
        >
          Previous
        </button>
        <span class="text-sm text-gray-700">
          Page {props.page} of {Math.max(props.totalPages, 1)}
        </span>
        <button
          class="px-3 py-2 text-sm font-medium text-gray-700 bg-gray-100 border border-gray-300 rounded-md hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={props.page >= props.totalPages}
          onClick={handleNext}
        >
          Next
        </button>

        <label class="ml-4 text-sm text-gray-700">Items per page:</label>
        <select
          class="px-2 py-2 border rounded-md text-sm"
          value={String(props.limit)}
          onChange={(e) => {
            const newLimit = parseInt(e.currentTarget.value)
            props.onLimitChange(newLimit)
          }}
        >
          <option value="10">10</option>
          <option value="25">25</option>
          <option value="50">50</option>
          <option value="100">100</option>
          <option value="200">200</option>
        </select>
      </div>
    </div>
  )
}
