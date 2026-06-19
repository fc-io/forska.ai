import {useQuery} from '@tanstack/solid-query'
import type {Accessor, Setter} from 'solid-js'
import {createEffect, createSignal, Show, Suspense} from 'solid-js'

import {createArticlesHumanReviewsQueryOptions} from '../../projects/projectsArticlesHumanReviewsQuery.ts'
import {ReviewsPaginationControls} from '../reviewsPaginationControls.tsx'
import type {ArticleWithHumanJudgments} from './reviewsArticlesHumanTable.tsx'
import {ReviewsArticlesHumanTable} from './reviewsArticlesHumanTable.tsx'

interface ReviewsArticlesHumanTableContainerProps {
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
}

export const ReviewsArticlesHumanTableContainer = (props: ReviewsArticlesHumanTableContainerProps) => {
  const [rowSelection, setRowSelection] = createSignal<Record<string, boolean>>({})
  const [selectAllMatching, setSelectAllMatching] = createSignal<boolean>(false)
  const [pageCursors, setPageCursors] = createSignal<Record<number, string | null>>({1: null})
  const [loadedPages, setLoadedPages] = createSignal<
    Record<number, {data: ArticleWithHumanJudgments[]; nextCursor?: string | null}>
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
  const articlesQuery = useQuery(() => {
    return createArticlesHumanReviewsQueryOptions(
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
    )
  })
  createEffect(() => {
    const nextCursor = articlesQuery.data?.nextCursor

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
    const loadedPage = {data: response.data as ArticleWithHumanJudgments[], nextCursor: response.nextCursor}
    setLoadedPages((prev) => {
      return prev[page]?.data === response.data ? prev : {...prev, [page]: loadedPage}
    })
  })
  createEffect(() => {
    if (props.currentPage() > 1 && pageCursors()[props.currentPage()] == null) {
      props.setCurrentPage(1)
    }
  })
  const loadedArticles = () => {
    const pages = loadedPages()

    return Array.from({length: props.currentPage()}, (_, index) => {
      return pages[index + 1]?.data ?? []
    }).flat()
  }

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
            const articles = () => {
              return loadedArticles()
            }

            return (
              <div class="space-y-4">
                <div class="p-4 bg-white rounded-lg shadow">
                  <h3 class="text-lg font-semibold mb-2">
                    {response().humanJudgmentMode === 'summary'
                      ? 'Articles with Overall Human Answers ('
                      : 'Articles with Human Judgments ('}
                    {response().totalCount > 0
                      ? `Showing 1-${Math.min(articles().length, response().totalCount)} of ${response().totalCount}`
                      : '0'}
                    )
                  </h3>
                  <p class="text-sm text-gray-600">
                    {response().humanJudgmentMode === 'summary'
                      ? 'Showing articles that have an overall human screening answer in this project'
                      : 'Showing articles that have human judgments for all prompts in this project'}
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
                  useCursorPagination
                  hasNextPage={Boolean(response().nextCursor)}
                  currentPageRowIds={articles().map((a) => {
                    return String(a.id)
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
                  when={articles().length > 0}
                  fallback={
                    <div class="p-8 text-center text-gray-500">
                      {response().humanJudgmentMode === 'summary'
                        ? 'No articles found with overall human answers'
                        : 'No articles found with complete human judgments'}
                      {Object.keys(props.promptFilters()).some((k) => {
                        const v = props.promptFilters()[k]
                        return Array.isArray(v) && v.length > 0
                      }) && ' for the selected filters'}
                    </div>
                  }
                >
                  <ReviewsArticlesHumanTable
                    projectId={props.projectId}
                    articles={articles()}
                    rowSelection={rowSelection}
                    setRowSelection={setRowSelection}
                    humanJudgmentMode={response().humanJudgmentMode}
                  />
                </Show>

                <ReviewsPaginationControls
                  page={props.currentPage()}
                  totalPages={response().totalPages}
                  setCurrentPage={props.setCurrentPage}
                  useCursorPagination
                  hasNextPage={Boolean(response().nextCursor)}
                  currentPageRowIds={articles().map((a) => {
                    return String(a.id)
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
            )
          }}
        </Show>
      </div>
    </Suspense>
  )
}
