import type {Setter} from 'solid-js'

interface ReviewsFilterControlsProps {
  filterAnsweredOriginal: () => boolean | null
  setFilterAnsweredOriginal: Setter<boolean | null>
  pageLimit: () => number
  setPageLimit: Setter<number>
  setCurrentPage: Setter<number>
}

export const ReviewsFilterControls = (props: ReviewsFilterControlsProps) => {
  const handleLimitChange = (newLimit: number) => {
    props.setPageLimit(newLimit)
    props.setCurrentPage(1)
  }

  return (
    <div class="flex items-center gap-4 p-4 bg-white rounded-lg shadow mb-6">
      <label class="font-medium">Filter by answered_original:</label>
      <select
        class="px-3 py-2 border rounded-md"
        value={
          props.filterAnsweredOriginal() === null
            ? 'all'
            : String(props.filterAnsweredOriginal())
        }
        onChange={(e) => {
          const value = e.target.value
          props.setFilterAnsweredOriginal(value === 'all' ? null : value === 'true')
          props.setCurrentPage(1)
        }}
      >
        <option value="all">All</option>
        <option value="true">Yes (Original)</option>
        <option value="false">No (Not Original)</option>
      </select>

      <label class="font-medium ml-auto">Items per page:</label>
      <select
        class="px-3 py-2 border rounded-md"
        value={String(props.pageLimit())}
        onChange={(e) => {
          return handleLimitChange(parseInt(e.target.value))
        }}
      >
        <option value="50">50</option>
        <option value="100">100</option>
        <option value="200">200</option>
        <option value="500">500</option>
      </select>
    </div>
  )
}