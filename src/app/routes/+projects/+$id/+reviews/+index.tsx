import {createFileRoute, Link} from '@tanstack/solid-router'
import {createSignal, Suspense} from 'solid-js'

import {ReviewsArticlesTableContainer} from '../../../../../components/main/reviews/reviewsArticlesTable/reviewsArticlesTableContainer.tsx'
import {ReviewsFilterControls} from '../../../../../components/main/reviews/reviewsFilterControls.tsx'
import {ReviewsTabs} from '../../../../../components/main/reviews/reviewsTabs.tsx'
import {Button} from '../../../../../components/ui/button'

const Reviews = () => {
  const params = Route.useParams()
  const [fromDate, setFromDate] = createSignal('')
  const [toDate, setToDate] = createSignal('')
  const [promptFilters, setPromptFilters] = createSignal<Record<string, string[] | null>>({})
  const [currentPage, setCurrentPage] = createSignal(1)
  const [pageLimit, setPageLimit] = createSignal(100)

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto">
      <Suspense>
        <div class="flex items-center justify-between mb-2">
          <h1 class="text-1xl font-bold">Project Reviews</h1>
          <Button as={Link} to="/projects/$id/humanAssessment" params={{id: params().id}} variant="outline" size="sm">
            Human Assessment
          </Button>
        </div>
        <ReviewsTabs projectId={params().id} active="assessed" />

        <ReviewsFilterControls
          projectId={params().id}
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
          projectId={params().id}
          promptFilters={promptFilters}
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
export const Route = createFileRoute('/projects/$id/reviews/')({component: Reviews})
