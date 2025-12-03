import {useQuery} from '@tanstack/solid-query'
import type {Accessor, Setter} from 'solid-js'
import {createEffect, createSignal, Show, Suspense} from 'solid-js'

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
  const [rowSelection, setRowSelection] = createSignal<Record<string, boolean>>({})
  const [selectAllMatching, setSelectAllMatching] = createSignal<boolean>(false)
  // Reset selection when filters/date/search/page size change
  createEffect(() => {
    // Access to track dependencies
    props.promptFilters()
    props.fromDate()
    props.toDate()
    props.searchTitle()
    props.pageLimit()
    props.currentPage()
    setRowSelection({})
    setSelectAllMatching(false)
  })
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
                  listType={'human'}
                  buildAddAllFilterBody={() => {
                    const prompts = Object.entries(props.promptFilters()).reduce(
                      (acc, [pid, val]) => {
                        if (Array.isArray(val) && val.length > 0) acc[pid] = val
                        return acc
                      },
                      {} as Record<string, string[]>,
                    )
                    const from = props.fromDate().trim()
                    const to = props.toDate().trim()
                    const search = (props.searchTitle() || '').trim()
                    const body: {prompts?: Record<string, string[]>; from?: string; to?: string; search?: string} = {}
                    if (Object.keys(prompts).length > 0) body.prompts = prompts
                    if (from) body.from = from
                    if (to) body.to = to
                    if (search) body.search = search
                    return body
                  }}
                />

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
                  <ReviewsArticlesHumanTable
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
                  listType={'human'}
                  buildAddAllFilterBody={() => {
                    const prompts = Object.entries(props.promptFilters()).reduce(
                      (acc, [pid, val]) => {
                        if (Array.isArray(val) && val.length > 0) acc[pid] = val
                        return acc
                      },
                      {} as Record<string, string[]>,
                    )
                    const from = props.fromDate().trim()
                    const to = props.toDate().trim()
                    const search = (props.searchTitle() || '').trim()
                    const body: {prompts?: Record<string, string[]>; from?: string; to?: string; search?: string} = {}
                    if (Object.keys(prompts).length > 0) body.prompts = prompts
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
