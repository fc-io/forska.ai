import {createFileRoute} from '@tanstack/solid-router'
import {createSignal} from 'solid-js'

import {ReviewsArticlesTableContainer} from '../../../../../components/main/reviews/reviewsArticlesTable/reviewsArticlesTableContainer.tsx'
import {ReviewsFilterControls} from '../../../../../components/main/reviews/reviewsFilterControls.tsx'
import {ReviewsTabs} from '../../../../../components/main/reviews/reviewsTabs.tsx'

const Reviews = () => {
  const [fromDate, setFromDate] = createSignal('')
  const [toDate, setToDate] = createSignal('')
  const params = Route.useParams()
  const projectId = (params() as {id: string}).id
  const [promptFilters, setPromptFilters] = createSignal<Record<string, string[] | null>>({})
  const [currentPage, setCurrentPage] = createSignal(1)
  const [pageLimit, setPageLimit] = createSignal(100)

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto">
      <h1 class="text-1xl font-bold mb-2">Project Reviews</h1>
      <ReviewsTabs projectId={projectId} active="assessed" />

      <ReviewsFilterControls
        projectId={projectId}
        promptFilters={promptFilters}
        setPromptFilters={setPromptFilters}
        pageLimit={pageLimit}
        setPageLimit={setPageLimit}
        setCurrentPage={setCurrentPage}
        fromDate={fromDate()}
        toDate={toDate()}
        setFromDate={setFromDate}
        setToDate={setToDate}
      />

      <ReviewsArticlesTableContainer
        projectId={projectId}
        promptFilters={promptFilters}
        currentPage={currentPage}
        setCurrentPage={setCurrentPage}
        pageLimit={pageLimit}
        fromDate={fromDate}
        toDate={toDate}
      />
    </div>
  )
}
export const Route = createFileRoute('/projects/$id/reviews/')({component: Reviews})
