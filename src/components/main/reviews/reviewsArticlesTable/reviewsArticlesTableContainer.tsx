import {useQuery} from '@tanstack/solid-query'
import type {Accessor, Setter} from 'solid-js'
import {createEffect, createMemo, createSignal, Show} from 'solid-js'

import {createArticlesReviewsCountQueryOptions} from '../../projects/projectsArticlesReviewsCountQuery.ts'
import {createArticlesReviewsQueryOptions} from '../../projects/projectsArticlesReviewsQuery.ts'
import {getReviewIndexingInProgressTitle} from '../getReviewIndexingInProgressTitle.ts'
import {ReviewsIndexingProgress} from '../reviewsIndexingProgress.tsx'
import {ReviewsPaginationControls} from '../reviewsPaginationControls.tsx'
import {createReviewsWarningsQueryOptions} from '../reviewsWarningsQuery.ts'
import {type ArticleWithJudgments, ReviewsArticlesTable} from './reviewsArticlesTable.tsx'

const formatThousandSeparatedNumber = (value: number) => {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

interface ReviewsArticlesTableContainerProps {
  projectId: string
  covidenceDuplicatesOnly: Accessor<boolean>
  covidenceConflictsOnly: Accessor<boolean>
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
  const [pageCursors, setPageCursors] = createSignal<Record<number, string | null>>({1: null})
  const [loadedPages, setLoadedPages] = createSignal<
    Record<number, {data: ArticleWithJudgments[]; nextCursor?: string | null}>
  >({})
  // Reset selection when filters/date/search/page size change
  createEffect(() => {
    // Access to track dependencies
    props.promptFilters()
    props.covidenceDuplicatesOnly()
    props.covidenceConflictsOnly()
    props.fromDate()
    props.toDate()
    props.searchTitle()
    props.pageLimit()
    setRowSelection({})
    setSelectAllMatching(false)
    setPageCursors({1: null})
    setLoadedPages({})
  })

  // Main data query - returns data immediately without waiting for count
  const articlesQuery = useQuery(() => {
    return {
      ...createArticlesReviewsQueryOptions(
        props.projectId,
        props.covidenceDuplicatesOnly,
        props.covidenceConflictsOnly,
        props.promptFilters,
        props.currentPage,
        () => {
          return pageCursors()[props.currentPage()]
        },
        props.pageLimit,
        props.fromDate,
        props.toDate,
        props.searchTitle,
      ),
      // Wait until URL filters are initialized to avoid duplicate calls
      enabled: props.initialized(),
    }
  })

  createEffect(() => {
    const response = articlesQuery.data

    if (!response || typeof response !== 'object' || !('nextCursor' in response)) {
      return
    }

    const nextCursor = response.nextCursor

    if (typeof nextCursor !== 'string' || nextCursor === '') {
      return
    }

    const nextPage = props.currentPage() + 1
    setPageCursors((prev) => {
      return prev[nextPage] === nextCursor ? prev : {...prev, [nextPage]: nextCursor}
    })
  })

  createEffect(() => {
    const response = articlesQuery.data

    if (!response || typeof response !== 'object' || !Array.isArray(response.data)) {
      return
    }

    const page = props.currentPage()
    setLoadedPages((prev) => {
      return prev[page] === response ? prev : {...prev, [page]: response}
    })
  })

  // Separate count query - loads asynchronously
  const countQuery = useQuery(() => {
    return {
      ...createArticlesReviewsCountQueryOptions(
        props.projectId,
        props.covidenceDuplicatesOnly,
        props.covidenceConflictsOnly,
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
  const warningsQuery = useQuery(() => {
    return createReviewsWarningsQueryOptions(props.projectId)
  })

  // Helper to get count values from either the count query or fall back to data response
  const totalCount = () => {
    return countQuery.isSuccess ? (countQuery.data?.totalCount ?? 0) : null
  }
  const totalPages = () => {
    return countQuery.isSuccess ? (countQuery.data?.totalPages ?? 0) : null
  }
  const useCursorPagination = true
  const hasPromptFilters = createMemo(() => {
    return Object.keys(props.promptFilters()).some((key) => {
      const value = props.promptFilters()[key]
      return Array.isArray(value) && value.length > 0
    })
  })
  const emptyState = createMemo(() => {
    const warningsData = warningsQuery.data

    return warningsData?.indexing.status === 'refreshing' && warningsData.scope.hasAnyArticlesInScope
      ? warningsData.indexing.pendingArticleRefreshCount > 0 && warningsData.indexing.pendingProjectRefreshCount === 0
        ? {
            description:
              'New judgments are still being folded into this project. Articles and counts here may change as the backlog clears.',
            title: 'New judgments are still being incorporated',
          }
        : {
            description:
              'This project has scoped articles, but the review index is still updating. Articles with judgments may appear here soon.',
            title: getReviewIndexingInProgressTitle(props.projectId),
          }
      : (warningsData?.indexing.status === 'failed' || warningsData?.indexing.status === 'stale')
          && warningsData.scope.hasAnyArticlesInScope
        ? {
            description:
              warningsData.indexing.status === 'failed'
                ? 'The latest review refresh failed. Results may stay stale or incomplete until the writer retries the review index.'
                : 'This project has scoped articles, but the review index is missing or stale. Results may stay empty until the writer rebuilds the review index.',
            title: warningsData.indexing.status === 'failed' ? 'Review indexing failed' : 'Review index is catching up',
          }
        : hasPromptFilters()
          ? {
              description: 'Try clearing one or more prompt filters or widening the date range.',
              title: 'No articles found for these filters',
            }
          : {
              description: 'No articles in this project have matching LLM judgments yet.',
              title: 'No articles found with judgments',
            }
  })

  const loadedArticles = () => {
    const pageCount = props.currentPage()
    const pages = loadedPages()
    return Array.from({length: pageCount}, (_, index) => {
      return pages[index + 1]?.data ?? []
    }).flat()
  }

  const currentResponse = () => {
    return loadedPages()[props.currentPage()] ?? articlesQuery.data
  }
  const isLoadingMore = () => {
    return articlesQuery.isFetching && loadedPages()[props.currentPage()] == null && props.currentPage() > 1
  }

  createEffect(() => {
    if (useCursorPagination && props.currentPage() > 1 && pageCursors()[props.currentPage()] == null) {
      props.setCurrentPage(1)
    }
  })

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
        <div class="space-y-4">
          <div class="p-4 bg-white rounded-lg shadow">
            <h3 class="text-lg font-semibold mb-2">
              Articles with Judgments (
              <span class="font-normal">
                <Show
                  when={totalCount() !== null}
                  fallback={
                    loadedArticles().length > 0 ? (
                      <span class="inline-flex items-center gap-2">
                        <span class="text-gray-600">{`Showing 1-${loadedArticles().length} of`}</span>
                        <span class="h-4 w-16 animate-pulse rounded bg-gray-200" />
                      </span>
                    ) : (
                      '0'
                    )
                  }
                >
                  {(totalCount() ?? 0) > 0
                    ? `Showing 1-${Math.min(loadedArticles().length, totalCount() ?? 0)} of ${formatThousandSeparatedNumber(totalCount() ?? 0)}`
                    : '0'}
                </Show>
              </span>
              )
            </h3>
            <p class="text-sm text-gray-600">
              Showing articles that have been judged by at least one prompt in this project
              {hasPromptFilters() && <span> (with filters applied)</span>}
            </p>
          </div>

          <ReviewsPaginationControls
            page={props.currentPage()}
            hasNextPage={typeof currentResponse()?.nextCursor === 'string' && currentResponse()?.nextCursor !== ''}
            isLoadingMore={isLoadingMore()}
            totalPages={totalPages()}
            setCurrentPage={props.setCurrentPage}
            useCursorPagination={useCursorPagination}
            currentPageRowIds={loadedArticles().map((a: {id: string}) => {
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
              const body: {
                prompts?: Record<string, string[]>
                from?: string
                to?: string
                search?: string
                hasDuplicateStudyRecords?: true
                hasStudyDecisionConflict?: true
              } = {}
              if (Object.keys(prompts).length > 0) body.prompts = prompts
              if (from) body.from = from
              if (to) body.to = to
              if (search) body.search = search
              if (props.covidenceDuplicatesOnly()) body.hasDuplicateStudyRecords = true
              if (props.covidenceConflictsOnly()) body.hasStudyDecisionConflict = true
              return body
            }}
          />

          <Show
            when={loadedArticles().length > 0}
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
              articles={loadedArticles()}
              rowSelection={rowSelection}
              setRowSelection={setRowSelection}
            />
          </Show>

          <ReviewsPaginationControls
            page={props.currentPage()}
            hasNextPage={typeof currentResponse()?.nextCursor === 'string' && currentResponse()?.nextCursor !== ''}
            isLoadingMore={isLoadingMore()}
            totalPages={totalPages()}
            setCurrentPage={props.setCurrentPage}
            useCursorPagination={useCursorPagination}
            currentPageRowIds={loadedArticles().map((a: {id: string}) => {
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
              const body: {
                prompts?: Record<string, string[]>
                from?: string
                to?: string
                search?: string
                hasDuplicateStudyRecords?: true
                hasStudyDecisionConflict?: true
              } = {}
              if (Object.keys(prompts).length > 0) body.prompts = prompts
              if (from) body.from = from
              if (to) body.to = to
              if (search) body.search = search
              if (props.covidenceDuplicatesOnly()) body.hasDuplicateStudyRecords = true
              if (props.covidenceConflictsOnly()) body.hasStudyDecisionConflict = true
              return body
            }}
          />
        </div>
      </Show>
    </div>
  )
}
