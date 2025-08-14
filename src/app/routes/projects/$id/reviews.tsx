import {useQuery} from '@tanstack/solid-query'
import {createFileRoute} from '@tanstack/solid-router'
import {createSignal, For, Show} from 'solid-js'

import {ReviewsArticleCard} from '../../../../components/main/reviews/reviewsArticleCard.tsx'
import {ReviewsFilterControls} from '../../../../components/main/reviews/reviewsFilterControls.tsx'
import {ReviewsPaginationControls} from '../../../../components/main/reviews/reviewsPaginationControls.tsx'
import type {articles, judgments} from '../../../../db/schema.ts'
import {apiClient} from '../../../../services/apiClient.ts'

type ArticleWithJudgments = typeof articles.$inferSelect & {
  judgments: Array<typeof judgments.$inferSelect>
}

const Reviews = () => {
  const params = Route.useParams()
  const projectId = (params() as {id: string}).id
  const [filterAnsweredOriginal, setFilterAnsweredOriginal] = createSignal<
    boolean | null
  >(null)
  const [currentPage, setCurrentPage] = createSignal(1)
  const [pageLimit, setPageLimit] = createSignal(100)

  const articlesQuery = useQuery(() => {
    return {
      queryKey: [
        'project-articles-reviews',
        projectId,
        filterAnsweredOriginal(),
        currentPage(),
        pageLimit(),
      ],
      queryFn: async () => {
        const queryParams: {
          answered_original?: string
          page?: string
          limit?: string
        } = {page: String(currentPage()), limit: String(pageLimit())}

        if (filterAnsweredOriginal() !== null) {
          queryParams.answered_original = String(filterAnsweredOriginal())
        }
        const response = await apiClient.api
          .projects({id: projectId})
          ['articles-reviews'].get({query: queryParams})

        if (response.error || !response.data) {
          throw new Error(
            response.error && typeof response.error === 'string'
              ? response.error
              : 'Failed to fetch articles',
          )
        }

        return response.data as {
          data: ArticleWithJudgments[]
          totalCount: number
          page: number
          limit: number
          totalPages: number
        }
      },
    }
  })

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto">
      <h1 class="text-3xl font-bold mb-6">Project Reviews</h1>

      <ReviewsFilterControls
        filterAnsweredOriginal={filterAnsweredOriginal}
        setFilterAnsweredOriginal={setFilterAnsweredOriginal}
        pageLimit={pageLimit}
        setPageLimit={setPageLimit}
        setCurrentPage={setCurrentPage}
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
            const articles = response().data
            const totalCount = response().totalCount
            const totalPages = response().totalPages
            const page = response().page

            return (
              <div class="space-y-4">
                <div class="p-4 bg-white rounded-lg shadow">
                  <h3 class="text-lg font-semibold mb-2">
                    Articles with Complete Judgments (
                    {totalCount > 0
                      ? `Showing ${Math.min(
                          (page - 1) * pageLimit() + 1,
                          totalCount,
                        )}-${Math.min(page * pageLimit(), totalCount)} of ${totalCount}`
                      : '0'}
                    )
                  </h3>
                  <p class="text-sm text-gray-600">
                    Showing articles that have judgments for all prompts in this
                    project
                    {filterAnsweredOriginal() !== null && (
                      <span>
                        {' '}
                        (filtered by answered_original ={' '}
                        {filterAnsweredOriginal() ? 'Yes' : 'No'})
                      </span>
                    )}
                  </p>
                </div>

                <Show when={totalPages > 1}>
                  <ReviewsPaginationControls
                    page={page}
                    totalPages={totalPages}
                    setCurrentPage={setCurrentPage}
                  />
                </Show>

                <Show
                  when={articles.length > 0}
                  fallback={
                    <div class="p-8 text-center text-gray-500">
                      No articles found with complete judgments
                      {filterAnsweredOriginal() !== null && ' for this filter'}
                    </div>
                  }
                >
                  <div class="grid gap-4">
                    <For each={articles}>
                      {(article) => {
                        return <ReviewsArticleCard article={article} />
                      }}
                    </For>
                  </div>
                </Show>

                <Show when={totalPages > 1}>
                  <ReviewsPaginationControls
                    page={page}
                    totalPages={totalPages}
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
export const Route = createFileRoute('/projects/$id/reviews')({
  component: Reviews,
})
