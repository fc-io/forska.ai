import {useQuery} from '@tanstack/solid-query'
import type {Accessor, Setter} from 'solid-js'
import {createEffect, createSignal, Show} from 'solid-js'

import {createArticlesReviewsCountQueryOptions} from '../../projects/projectsArticlesReviewsCountQuery.ts'
import {createArticlesReviewsQueryOptions} from '../../projects/projectsArticlesReviewsQuery.ts'
import {ReviewsPaginationControls} from '../reviewsPaginationControls.tsx'
import {ReviewsArticlesTable} from './reviewsArticlesTable.tsx'

const formatThousandSeparatedNumber = (value: number) => {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

interface ReviewsArticlesTableContainerProps {
  projectId: string
  isAdmin: boolean
  promptFilters: Accessor<Record<string, string[] | null>>
  currentPage: Accessor<number>
  setCurrentPage: Setter<number>
  pageLimit: Accessor<number>
  fromDate: Accessor<string>
  toDate: Accessor<string>
  searchTitle: Accessor<string>
  /** Whether URL filters have been initialized - queries will wait until true */
  initialized: Accessor<boolean>
}

export const ReviewsArticlesTableContainer = (props: ReviewsArticlesTableContainerProps) => {
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

  // Main data query - returns data immediately without waiting for count
  const articlesQuery = useQuery(() => {
    return {
      ...createArticlesReviewsQueryOptions(
        props.projectId,
        props.promptFilters,
        props.currentPage,
        props.pageLimit,
        props.fromDate,
        props.toDate,
        props.searchTitle,
      ),
      // Wait until URL filters are initialized to avoid duplicate calls
      enabled: props.initialized(),
    }
  })

  // Separate count query - loads asynchronously
  const countQuery = useQuery(() => {
    return {
      ...createArticlesReviewsCountQueryOptions(
        props.projectId,
        props.promptFilters,
        props.pageLimit,
        props.fromDate,
        props.toDate,
        props.searchTitle,
      ),
      // Wait until URL filters are initialized to avoid duplicate calls
      enabled: props.initialized() && articlesQuery.isSuccess && !articlesQuery.isFetching,
    }
  })

  // Helper to get count values from either the count query or fall back to data response
  const totalCount = () => {
    return countQuery.isSuccess ? (countQuery.data?.totalCount ?? 0) : null
  }
  const totalPages = () => {
    return countQuery.isSuccess ? (countQuery.data?.totalPages ?? 0) : null
  }

  return (
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

      <Show when={articlesQuery.isSuccess && articlesQuery.data}>
        {(response) => {
          return (
            <div class="space-y-4">
              <div class="p-4 bg-white rounded-lg shadow">
                <h3 class="text-lg font-semibold mb-2">
                  Articles with Judgments (
                  <span class="font-normal">
                    <Show
                      when={totalCount() !== null}
                      fallback={
                        response().data.length > 0 ? (
                          <span class="inline-flex items-center gap-2">
                            <span class="text-gray-600">
                              {`Showing ${(response().page - 1) * props.pageLimit() + 1}-${(response().page - 1) * props.pageLimit() + response().data.length} of`}
                            </span>
                            <span class="h-4 w-16 animate-pulse rounded bg-gray-200" />
                          </span>
                        ) : (
                          '0'
                        )
                      }
                    >
                      {(totalCount() ?? 0) > 0
                        ? `Showing ${Math.min((response().page - 1) * props.pageLimit() + 1, totalCount() ?? 0)}-${Math.min(response().page * props.pageLimit(), totalCount() ?? 0)} of ${formatThousandSeparatedNumber(totalCount() ?? 0)}`
                        : '0'}
                    </Show>
                  </span>
                  )
                </h3>
                <p class="text-sm text-gray-600">
                  Showing articles that have been judged by at least one prompt in this project
                  {Object.keys(props.promptFilters()).some((k) => {
                    const v = props.promptFilters()[k]
                    return Array.isArray(v) && v.length > 0
                  }) && <span> (with filters applied)</span>}
                </p>
              </div>

              <ReviewsPaginationControls
                page={props.currentPage()}
                totalPages={totalPages()}
                setCurrentPage={props.setCurrentPage}
                isAdmin={props.isAdmin}
                currentPageRowIds={response().data.map((a) => {
                  return a.id
                })}
                rowSelection={rowSelection}
                setRowSelection={setRowSelection}
                totalMatchingCount={totalCount()}
                selectAllMatching={selectAllMatching}
                setSelectAllMatching={setSelectAllMatching}
                sourceProjectId={props.projectId}
                listType={'llm'}
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
                    No articles found with judgments
                    {Object.keys(props.promptFilters()).some((k) => {
                      const v = props.promptFilters()[k]
                      return Array.isArray(v) && v.length > 0
                    }) && ' for the selected filters'}
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
                totalPages={totalPages()}
                setCurrentPage={props.setCurrentPage}
                isAdmin={props.isAdmin}
                currentPageRowIds={response().data.map((a) => {
                  return a.id
                })}
                rowSelection={rowSelection}
                setRowSelection={setRowSelection}
                totalMatchingCount={totalCount()}
                selectAllMatching={selectAllMatching}
                setSelectAllMatching={setSelectAllMatching}
                sourceProjectId={props.projectId}
                listType={'llm'}
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
  )
}
