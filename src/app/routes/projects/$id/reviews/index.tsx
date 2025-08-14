import {useQuery} from '@tanstack/solid-query'
import {createFileRoute} from '@tanstack/solid-router'
import {format} from 'date-fns'
import {createSignal, Show} from 'solid-js'

import {ReviewsArticlesTable} from '../../../../../components/main/reviews/reviewsArticlesTable/reviewsArticlesTable.tsx'
import {ReviewsFilterControls} from '../../../../../components/main/reviews/reviewsFilterControls.tsx'
import {ReviewsPaginationControls} from '../../../../../components/main/reviews/reviewsPaginationControls.tsx'
import {apiClient} from '../../../../../services/apiClient.ts'
// const setFromDate = (date: Date) => {
//   console.log('setFromDate', date)

//   // setState(
//   //   produce((s) => {
//   //     s.fromDate = date
//   //   }),
//   // )
// }

// const setToDate = (date: Date) => {
//   console.log('setToDate', date)

//   // setState(
//   //   produce((s) => {
//   //     s.toDate = date
//   //   }),
//   // )
// }

const Reviews = () => {
  const [fromDate, setFromDate] = createSignal(new Date())
  const [toDate, setToDate] = createSignal(new Date())
  const params = Route.useParams()
  const projectId = (params() as {id: string}).id
  const [promptFilters, setPromptFilters] = createSignal<
    Record<string, string | null>
  >({})
  const [currentPage, setCurrentPage] = createSignal(1)
  const [pageLimit, setPageLimit] = createSignal(100)

  const articlesQuery = useQuery(() => {
    return {
      queryKey: [
        'project-articles-reviews-filters',
        projectId,
        promptFilters(),
        currentPage(),
        pageLimit(),
        fromDate(),
        toDate(),
      ],
      queryFn: async () => {
        const query = {
          page: String(currentPage()),
          limit: String(pageLimit()),
          projectId,
          from: format(fromDate(), 'yyyy-MM-dd'),
          to: format(toDate(), 'yyyy-MM-dd'),
          prompts: Object.entries(promptFilters()).reduce(
            (acc, [promptId, value]) => {
              if (value !== null) {
                acc[promptId] = value
              }
              return acc
            },
            {} as Record<string, string>,
          ),
        }

        const response = await apiClient.api.articlesreviews.get({query})

        if (!response.data) {
          throw new Error('Failed to fetch articles')
        }

        return response.data
      },
    }
  })

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto">
      <h1 class="text-1xl font-bold mb-6">Project Reviews</h1>

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

      <div class="space-y-4">
        <Show when={articlesQuery.isPending}>
          <div class="flex justify-center p-8">
            <div class="text-gray-500">Loading articles...</div>
          </div>
        </Show>

        <Show when={articlesQuery.error}>
          <div class="p-4 bg-red-50 border border-red-200 rounded-lg">
            <p class="text-red-600">
              Error loading articles: {articlesQuery.error?.message}
            </p>
          </div>
        </Show>

        <Show when={articlesQuery.data}>
          {(response) => {
            return (
              <div class="space-y-4">
                <div class="p-4 bg-white rounded-lg shadow">
                  <h3 class="text-lg font-semibold mb-2">
                    Articles with Complete Judgments (
                    {response().totalCount > 0
                      ? `Showing ${Math.min(
                          (response().page - 1) * pageLimit() + 1,
                          response().totalCount,
                        )}-${Math.min(response().page * pageLimit(), response().totalCount)} of ${response().totalCount}`
                      : '0'}
                    )
                  </h3>
                  <p class="text-sm text-gray-600">
                    Showing articles that have judgments for all prompts in this
                    project
                    {Object.keys(promptFilters()).length > 0 && (
                      <span> (with filters applied)</span>
                    )}
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
                  fallback={
                    <div class="p-8 text-center text-gray-500">
                      No articles found with complete judgments
                      {Object.keys(promptFilters()).some((k) => {
                        return promptFilters()[k] !== null
                      }) && ' for the selected filters'}
                    </div>
                  }
                >
                  <ReviewsArticlesTable
                    projectId={projectId}
                    articles={response().data}
                  />
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
export const Route = createFileRoute('/projects/$id/reviews/')({
  component: Reviews,
})
