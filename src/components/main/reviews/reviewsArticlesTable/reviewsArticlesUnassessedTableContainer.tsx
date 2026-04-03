import {useQuery} from '@tanstack/solid-query'
import type {Accessor, Setter} from 'solid-js'
import {createEffect, createMemo, createSignal, Show, Suspense} from 'solid-js'

import {createArticlesUnassessedQueryOptions} from '../../projects/projectsArticlesUnassessedQuery.ts'
import {getReviewIndexingInProgressTitle} from '../getReviewIndexingInProgressTitle.ts'
import {ReviewsIndexingProgress} from '../reviewsIndexingProgress.tsx'
import {ReviewsPaginationControls} from '../reviewsPaginationControls.tsx'
import {createReviewsWarningsQueryOptions} from '../reviewsWarningsQuery.ts'
import {ReviewsArticlesTable} from './reviewsArticlesTable.tsx'

const formatThousandSeparatedNumber = (value: number) => {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

interface ReviewsArticlesUnassessedTableContainerProps {
  projectId: string
  currentPage: Accessor<number>
  setCurrentPage: Setter<number>
  pageLimit: Accessor<number>
  fromDate: Accessor<string>
  toDate: Accessor<string>
  searchTitle: Accessor<string>
}

export const ReviewsArticlesUnassessedTableContainer = (props: ReviewsArticlesUnassessedTableContainerProps) => {
  const [rowSelection, setRowSelection] = createSignal<Record<string, boolean>>({})
  const [selectAllMatching, setSelectAllMatching] = createSignal<boolean>(false)
  // Reset selection when date/search/page size change
  createEffect(() => {
    // Access to track dependencies
    props.fromDate()
    props.toDate()
    props.searchTitle()
    props.pageLimit()
    props.currentPage()
    setRowSelection({})
    setSelectAllMatching(false)
  })
  const articlesQuery = useQuery(() => {
    return createArticlesUnassessedQueryOptions(
      props.projectId,
      props.currentPage,
      props.pageLimit,
      props.fromDate,
      props.toDate,
      props.searchTitle,
    )
  })
  const warningsQuery = useQuery(() => {
    return createReviewsWarningsQueryOptions(props.projectId)
  })
  const hasFilters = createMemo(() => {
    return Boolean(props.fromDate().trim() || props.toDate().trim() || (props.searchTitle() || '').trim())
  })
  const emptyState = createMemo(() => {
    const warningsData = warningsQuery.data

    return warningsData?.indexing.status === 'refreshing' && warningsData.scope.hasAnyArticlesInScope
      ? warningsData.indexing.pendingArticleRefreshCount > 0 && warningsData.indexing.pendingProjectRefreshCount === 0
        ? {
            description:
              'New judgments are still being folded into this project. This list may change as the backlog clears.',
            title: 'New judgments are still being incorporated',
          }
        : {
            description:
              'This project has scoped articles, but the review index is still updating. The unassessed list may appear empty until indexing finishes.',
            title: getReviewIndexingInProgressTitle(props.projectId),
          }
      : (warningsData?.indexing.status === 'failed' || warningsData?.indexing.status === 'stale')
          && warningsData.scope.hasAnyArticlesInScope
        ? {
            description:
              warningsData.indexing.status === 'failed'
                ? 'The latest review refresh failed. Unassessed results may stay stale or incomplete until the writer retries the review index.'
                : 'This project has scoped articles, but the review index is missing or stale. Unassessed results may stay empty until the writer rebuilds the review index.',
            title: warningsData.indexing.status === 'failed' ? 'Review indexing failed' : 'Review index is catching up',
          }
        : hasFilters()
          ? {
              description: 'Try widening the date range or clearing the title search.',
              title: 'No unassessed articles match these filters',
            }
          : {
              description: 'Every scoped article already has the required LLM judgments for this project.',
              title: 'No unassessed articles found',
            }
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
                    Articles with No Judgments (
                    {response().totalCount > 0
                      ? `Showing ${Math.min((response().page - 1) * props.pageLimit() + 1, response().totalCount)}-${Math.min(response().page * props.pageLimit(), response().totalCount)} of ${formatThousandSeparatedNumber(response().totalCount)}`
                      : '0'}
                    )
                  </h3>
                  <p class="text-sm text-gray-600">
                    Showing articles missing at least one LLM judgment for this project's prompts
                  </p>
                </div>

                <ReviewsPaginationControls
                  page={props.currentPage()}
                  totalPages={response().totalPages}
                  setCurrentPage={props.setCurrentPage}
                  currentPageRowIds={response().data.map((a) => {
                    return a.id
                  })}
                  rowSelection={rowSelection}
                  setRowSelection={setRowSelection}
                  totalMatchingCount={response().totalCount}
                  selectAllMatching={selectAllMatching}
                  setSelectAllMatching={setSelectAllMatching}
                  sourceProjectId={props.projectId}
                  listType={'unassessed'}
                  buildAddAllFilterBody={() => {
                    const from = props.fromDate().trim()
                    const to = props.toDate().trim()
                    const search = (props.searchTitle() || '').trim()
                    const body: {from?: string; to?: string; search?: string} = {}
                    if (from) body.from = from
                    if (to) body.to = to
                    if (search) body.search = search
                    return body
                  }}
                />

                <Show
                  when={response().data.length > 0}
                  fallback={
                    <div class="rounded-lg border border-slate-200 bg-slate-50 p-8 text-center">
                      <p class="font-medium text-slate-800">{emptyState().title}</p>
                      <p class="mt-2 text-sm text-slate-600">{emptyState().description}</p>
                      <Show when={warningsQuery.data?.scope.hasAnyArticlesInScope ? warningsQuery.data.indexing : null}>
                        {(indexing) => {
                          return <ReviewsIndexingProgress indexing={indexing()} compact />
                        }}
                      </Show>
                    </div>
                  }
                >
                  <ReviewsArticlesTable
                    projectId={props.projectId}
                    articles={response().data}
                    rowSelection={rowSelection}
                    setRowSelection={setRowSelection}
                  />
                </Show>

                <ReviewsPaginationControls
                  page={props.currentPage()}
                  totalPages={response().totalPages}
                  setCurrentPage={props.setCurrentPage}
                  currentPageRowIds={response().data.map((a) => {
                    return a.id
                  })}
                  rowSelection={rowSelection}
                  setRowSelection={setRowSelection}
                  totalMatchingCount={response().totalCount}
                  selectAllMatching={selectAllMatching}
                  setSelectAllMatching={setSelectAllMatching}
                  sourceProjectId={props.projectId}
                  listType={'unassessed'}
                  buildAddAllFilterBody={() => {
                    const from = props.fromDate().trim()
                    const to = props.toDate().trim()
                    const search = (props.searchTitle() || '').trim()
                    const body: {from?: string; to?: string; search?: string} = {}
                    if (from) body.from = from
                    if (to) body.to = to
                    if (search) body.search = search
                    return body
                  }}
                />
              </div>
            )
          }}
        </Show>
      </div>
    </Suspense>
  )
}
