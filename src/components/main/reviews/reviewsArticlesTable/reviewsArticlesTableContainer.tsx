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

      <Show when={articlesQuery.isSuccess}>
        {() => {
          const response = () => {
            return articlesQuery.data
          }
          const responseValue = response()
          if (!responseValue) return null

          return (
            <div class="space-y-4">
              <div class="p-4 bg-white rounded-lg shadow">
                <h3 class="text-lg font-semibold mb-2">
                  Articles with Judgments (
                  <span class={totalCount() === null ? 'text-gray-400 animate-pulse' : undefined}>
                    {(() => {
                      const page = responseValue.page
                      const limit = props.pageLimit()
                      const len = responseValue.data.length
                      const count = totalCount()
                      const start = len > 0 ? (page - 1) * limit + 1 : 0
                      const end = len > 0 ? (page - 1) * limit + len : 0

                      if (count === null) {
                        return len > 0 ? `Showing ${start}-${end} of ...` : '0'
                      }

                      return count > 0
                        ? `Showing ${Math.min((page - 1) * limit + 1, count)}-${Math.min(page * limit, count)} of ${formatThousandSeparatedNumber(count)}`
                        : '0'
                    })()}
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
                currentPageRowIds={responseValue.data.map((a) => {
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
                when={responseValue.data.length > 0}
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
                  articles={responseValue.data}
                  rowSelection={rowSelection}
                  setRowSelection={setRowSelection}
                />
              </Show>

              <ReviewsPaginationControls
                page={props.currentPage()}
                totalPages={totalPages()}
                setCurrentPage={props.setCurrentPage}
                isAdmin={props.isAdmin}
                currentPageRowIds={responseValue.data.map((a) => {
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
