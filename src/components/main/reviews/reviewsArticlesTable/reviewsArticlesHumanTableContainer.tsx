import {useQuery} from '@tanstack/solid-query'
import type {Accessor, Setter} from 'solid-js'
import {Show, Suspense} from 'solid-js'

import {createArticlesHumanReviewsQueryOptions} from '../../projects/projectsArticlesHumanReviewsQuery.ts'
import {ReviewsPaginationControls} from '../reviewsPaginationControls.tsx'
import {ReviewsArticlesHumanTable} from './reviewsArticlesHumanTable.tsx'

interface ReviewsArticlesHumanTableContainerProps {
  projectId: string
  promptFilters: Accessor<Record<string, string[] | null>>
  currentPage: Accessor<number>
  setCurrentPage: Setter<number>
  pageLimit: Accessor<number>
  fromDate: Accessor<string>
  toDate: Accessor<string>
  searchTitle: Accessor<string>
}

export const ReviewsArticlesHumanTableContainer = (props: ReviewsArticlesHumanTableContainerProps) => {
  const articlesQuery = useQuery(() => {
    return createArticlesHumanReviewsQueryOptions(
      props.projectId,
      props.promptFilters,
      props.currentPage,
      props.pageLimit,
      props.fromDate,
      props.toDate,
      props.searchTitle,
    )
  })

  return (
    <Suspense>
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
                    Articles with Human Judgments (
                    {response().totalCount > 0
                      ? `Showing ${Math.min((response().page - 1) * props.pageLimit() + 1, response().totalCount)}-${Math.min(response().page * props.pageLimit(), response().totalCount)} of ${response().totalCount}`
                      : '0'}
                    )
                  </h3>
                  <p class="text-sm text-gray-600">
                    Showing articles that have human judgments for all prompts in this project
                    {Object.keys(props.promptFilters()).some((k) => {
                      const v = props.promptFilters()[k]
                      return Array.isArray(v) && v.length > 0
                    }) && <span> (with filters applied)</span>}
                  </p>
                </div>

                <Show when={response().totalPages > 1}>
                  <ReviewsPaginationControls
                    page={props.currentPage()}
                    totalPages={response().totalPages}
                    setCurrentPage={props.setCurrentPage}
                  />
                </Show>

                <Show
                  when={response().data.length > 0}
                  fallback={
                    <div class="p-8 text-center text-gray-500">
                      No articles found with complete human judgments
                      {Object.keys(props.promptFilters()).some((k) => {
                        const v = props.promptFilters()[k]
                        return Array.isArray(v) && v.length > 0
                      }) && ' for the selected filters'}
                    </div>
                  }
                >
                  <ReviewsArticlesHumanTable projectId={props.projectId} articles={response().data} />
                </Show>

                <Show when={response().totalPages > 1}>
                  <ReviewsPaginationControls
                    page={props.currentPage()}
                    totalPages={response().totalPages}
                    setCurrentPage={props.setCurrentPage}
                  />
                </Show>
              </div>
            )
          }}
        </Show>
      </div>
    </Suspense>
  )
}

