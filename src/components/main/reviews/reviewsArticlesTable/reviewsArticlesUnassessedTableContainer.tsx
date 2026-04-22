import {useQuery} from '@tanstack/solid-query'
import type {Accessor, Setter} from 'solid-js'
import {createEffect, createMemo, createSignal, Show, Suspense} from 'solid-js'

import {createArticlesUnassessedQueryOptions} from '../../projects/projectsArticlesUnassessedQuery.ts'
import {getReviewIndexingStateCopy} from '../getReviewIndexingInProgressTitle.ts'
import {ReviewsIndexingProgress} from '../reviewsIndexingProgress.tsx'
import {ReviewsPaginationControls} from '../reviewsPaginationControls.tsx'
import {createReviewsWarningsQueryOptions} from '../reviewsWarningsQuery.ts'
import {ReviewsArticlesTable} from './reviewsArticlesTable.tsx'

const formatThousandSeparatedNumber = (value: number) => {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

interface ReviewsArticlesUnassessedTableContainerProps {
  projectId: string
  covidenceDuplicatesOnly: Accessor<boolean>
  covidenceConflictsOnly: Accessor<boolean>
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
    props.covidenceDuplicatesOnly()
    props.covidenceConflictsOnly()
    props.searchTitle()
    props.pageLimit()
    props.currentPage()
    setRowSelection({})
    setSelectAllMatching(false)
  })
  const articlesQuery = useQuery(() => {
    return createArticlesUnassessedQueryOptions(
      props.projectId,
      props.covidenceDuplicatesOnly,
      props.covidenceConflictsOnly,
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
    const reviewIndexingCopy =
      warningsData?.scope.hasAnyArticlesInScope
      && (warningsData.indexing.status === 'blocked'
        || warningsData.indexing.status === 'failed'
        || warningsData.indexing.status === 'refreshing'
        || warningsData.indexing.status === 'stale')
        ? getReviewIndexingStateCopy({
            indexing: warningsData.indexing,
            projectId: props.projectId,
            surface: 'unassessedEmpty',
          })
        : null

    return reviewIndexingCopy
      ? reviewIndexingCopy
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
    <Suspense fallback={null}>
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
                    const body: {
                      from?: string
                      to?: string
                      search?: string
                      hasDuplicateStudyRecords?: true
                      hasStudyDecisionConflict?: true
                    } = {}
                    if (from) body.from = from
                    if (to) body.to = to
                    if (search) body.search = search
                    if (props.covidenceDuplicatesOnly()) body.hasDuplicateStudyRecords = true
                    if (props.covidenceConflictsOnly()) body.hasStudyDecisionConflict = true
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
                    const body: {
                      from?: string
                      to?: string
                      search?: string
                      hasDuplicateStudyRecords?: true
                      hasStudyDecisionConflict?: true
                    } = {}
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
