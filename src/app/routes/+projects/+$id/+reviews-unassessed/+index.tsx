import {useQuery} from '@tanstack/solid-query'
import {createFileRoute} from '@tanstack/solid-router'
import {createSignal, Show} from 'solid-js'

import {createArticlesUnassessedQueryOptions} from '../../../../../components/main/projects/projectsArticlesUnassessedQuery.ts'
import {ReviewsArticlesTable} from '../../../../../components/main/reviews/reviewsArticlesTable/reviewsArticlesTable.tsx'
import {ReviewsFilterControls} from '../../../../../components/main/reviews/reviewsFilterControls.tsx'
import {ReviewsPaginationControls} from '../../../../../components/main/reviews/reviewsPaginationControls.tsx'
import {ReviewsTabs} from '../../../../../components/main/reviews/reviewsTabs.tsx'

const ReviewsUnassessed = () => {
  const [fromDate, setFromDate] = createSignal('')
  const [toDate, setToDate] = createSignal('')
  const params = Route.useParams()
  const projectId = (params() as {id: string}).id
  const [currentPage, setCurrentPage] = createSignal(1)
  const [pageLimit, setPageLimit] = createSignal(100)

  const articlesQuery = useQuery(() => {
    return createArticlesUnassessedQueryOptions(projectId, currentPage, pageLimit, fromDate, toDate)
  })

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto">
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

      <div class="space-y-4">
        <Show when={articlesQuery.isPending}>
          <div class="flex justify-center p-8">
            <div class="text-gray-500">Loading articles...</div>
          </div>
        </Show>

        <Show when={articlesQuery.error}>
          <div class="p-4 bg-red-50 border border-red-200 rounded-lg">
            <p class="text-red-600">Error loading articles: {articlesQuery.error?.message}</p>
          </div>
        </Show>

        <Show when={articlesQuery.data}>
          {(response) => {
            return (
              <div class="space-y-4">
                <div class="p-4 bg-white rounded-lg shadow">
                  <h3 class="text-lg font-semibold mb-2">
                    Articles with No Judgments (
                    {response().totalCount > 0
                      ? `Showing ${Math.min(
                          (response().page - 1) * pageLimit() + 1,
                          response().totalCount,
                        )}-${Math.min(response().page * pageLimit(), response().totalCount)} of ${response().totalCount}`
                      : '0'}
                    )
                  </h3>
                  <p class="text-sm text-gray-600">
                    Showing articles that have no judgments for any prompts in this project
                  </p>
                </div>

                <Show when={response().totalPages > 1}>
                  <ReviewsPaginationControls
                    page={currentPage()}
                    totalPages={response().totalPages}
                    setCurrentPage={setCurrentPage}
                  />
                </Show>

                <Show
                  when={response().data.length > 0}
                  fallback={<div class="p-8 text-center text-gray-500">No unassessed articles found</div>}
                >
                  <ReviewsArticlesTable projectId={projectId} articles={response().data} />
                </Show>

                <Show when={response().totalPages > 1}>
                  <ReviewsPaginationControls
                    page={currentPage()}
                    totalPages={response().totalPages}
                    setCurrentPage={setCurrentPage}
                  />
                </Show>
              </div>
            )
          }}
        </Show>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/projects/$id/reviews-unassessed/')({component: ReviewsUnassessed})
