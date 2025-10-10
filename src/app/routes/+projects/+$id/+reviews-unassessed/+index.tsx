import {createFileRoute} from '@tanstack/solid-router'
import {createSignal, Suspense} from 'solid-js'

import {ReviewsArticlesUnassessedTableContainer} from '../../../../../components/main/reviews/reviewsArticlesTable/reviewsArticlesUnassessedTableContainer.tsx'
import {ReviewsFilterControls} from '../../../../../components/main/reviews/reviewsFilterControls.tsx'
import {ReviewsTabs} from '../../../../../components/main/reviews/reviewsTabs.tsx'

const ReviewsUnassessed = () => {
  const [fromDate, setFromDate] = createSignal('')
  const [toDate, setToDate] = createSignal('')
  const params = Route.useParams()
  const projectId = (params() as {id: string}).id
  const [currentPage, setCurrentPage] = createSignal(1)
  const [pageLimit, setPageLimit] = createSignal(100)

  // Data for the table is now loaded inside the table container component

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto">
      <Suspense>
        <h1 class="text-1xl font-bold mb-2">Project Reviews</h1>
        <ReviewsTabs projectId={projectId} active="unassessed" />

        <ReviewsFilterControls
          projectId={projectId}
          promptFilters={() => {
            return {}
          }}
          setPromptFilters={() => {
            return
          }}
          pageLimit={pageLimit}
          setPageLimit={setPageLimit}
          setCurrentPage={setCurrentPage}
          fromDate={fromDate()}
          toDate={toDate()}
          setFromDate={setFromDate}
          setToDate={setToDate}
          hidePromptSelectors={true}
        />

        <ReviewsArticlesUnassessedTableContainer
          projectId={projectId}
          currentPage={currentPage}
          setCurrentPage={setCurrentPage}
          pageLimit={pageLimit}
          fromDate={fromDate}
          toDate={toDate}
        />
      </Suspense>
    </div>
  )
}

export const Route = createFileRoute('/projects/$id/reviews-unassessed/')({component: ReviewsUnassessed})
