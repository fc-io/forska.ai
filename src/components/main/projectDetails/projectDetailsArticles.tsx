import {useQuery} from '@tanstack/solid-query'
import {format} from 'date-fns'
import {createSignal, For, Show, Suspense} from 'solid-js'

import {getArticleUrl} from '../../../app/utils/getArticleUrl.ts'
import type {articles, judgments} from '../../../db/schema.ts'
import {apiClient} from '../../../services/apiClient.ts'
import {handleApiResponse} from '../../../services/utils/handleApiResponse'
import {DateRangePicker} from '../dateRangePicker'

type ArticleWithJudgments = typeof articles.$inferSelect & {judgments: Array<typeof judgments.$inferSelect>}

export const ProjectDetailsArticles = (props: {projectId: string}) => {
  const [filterAnsweredOriginal, setFilterAnsweredOriginal] = createSignal<boolean | null>(null)
  const [currentPage, setCurrentPage] = createSignal(1)
  const [pageLimit, setPageLimit] = createSignal(100)
  const [fromDate, setFromDate] = createSignal(new Date())
  const [toDate, setToDate] = createSignal(new Date())

  const articlesQuery = useQuery(() => {
    return {
      queryKey: [
        'project-articles-with-judgments',
        props.projectId,
        filterAnsweredOriginal(),
        currentPage(),
        pageLimit(),
        fromDate(),
        toDate(),
      ],
      queryFn: async () => {
        const queryParams: {answered_original?: string; page?: string; limit?: string; from?: string; to?: string} = {
          page: String(currentPage()),
          limit: String(pageLimit()),
        }

        if (filterAnsweredOriginal() !== null) {
          queryParams.answered_original = String(filterAnsweredOriginal())
        }
        queryParams.from = format(fromDate(), 'yyyy-MM-dd')
        queryParams.to = format(toDate(), 'yyyy-MM-dd')
        const response = await apiClient.api
          .projects({id: props.projectId})
          ['articles-with-judgments'].get({query: queryParams})

        const data = handleApiResponse(response, 'Failed to fetch articles')
        return data as {
          data: ArticleWithJudgments[]
          totalCount: number
          page: number
          limit: number
          totalPages: number
        }
      },
    }
  })

  const handlePageChange = (newPage: number) => {
    setCurrentPage(newPage)
  }

  const handleLimitChange = (newLimit: number) => {
    setPageLimit(newLimit)
    setCurrentPage(1) // Reset to first page when changing limit
  }

  return (
    <Suspense>
      <div class="flex items-center gap-4 p-4 bg-white rounded-lg shadow">
        <DateRangePicker
          defaultStart={fromDate()}
          defaultEnd={toDate()}
          onValueChange={([start, end]) => {
            setFromDate(start)
            setToDate(end)
            setCurrentPage(1)
          }}
        />
        <label class="font-medium ml-4">Filter by answered_original:</label>
        <select
          class="px-3 py-2 border rounded-md"
          value={filterAnsweredOriginal() === null ? 'all' : String(filterAnsweredOriginal())}
          onChange={(e) => {
            const value = e.target.value
            setFilterAnsweredOriginal(value === 'all' ? null : value === 'true')
            setCurrentPage(1) // Reset to first page when filter changes
          }}
        >
          <option value="all">All</option>
          <option value="true">Yes (Original)</option>
          <option value="false">No (Not Original)</option>
        </select>

        <label class="font-medium ml-auto">Items per page:</label>
        <select
          class="px-3 py-2 border rounded-md"
          value={String(pageLimit())}
          onChange={(e) => {
            return handleLimitChange(parseInt(e.target.value))
          }}
        >
          <option value="50">50</option>
          <option value="100">100</option>
          <option value="200">200</option>
          <option value="500">500</option>
        </select>
      </div>
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
                    Showing articles that have judgments for all prompts in this project
                    {filterAnsweredOriginal() !== null && (
                      <span> (filtered by answered_original = {filterAnsweredOriginal() ? 'Yes' : 'No'})</span>
                    )}
                  </p>
                </div>

                <Show when={totalPages > 1}>
                  <div class="flex items-center justify-center gap-2 p-4 bg-white rounded-lg shadow">
                    <button
                      class="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 border border-gray-300 rounded-md hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
                      disabled={page <= 1}
                      onClick={() => {
                        return handlePageChange(page - 1)
                      }}
                    >
                      Previous
                    </button>

                    <span class="mx-4 text-sm text-gray-700">
                      Page {page} of {totalPages}
                    </span>

                    <button
                      class="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 border border-gray-300 rounded-md hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
                      disabled={page >= totalPages}
                      onClick={() => {
                        return handlePageChange(page + 1)
                      }}
                    >
                      Next
                    </button>

                    <div class="ml-4 flex items-center gap-2">
                      <label class="text-sm text-gray-700">Go to page:</label>
                      <input
                        type="number"
                        min="1"
                        max={totalPages}
                        value={page}
                        class="w-16 px-2 py-1 text-sm border rounded-md"
                        onInput={(e) => {
                          const newPage = parseInt(e.target.value)
                          if (newPage >= 1 && newPage <= totalPages) {
                            handlePageChange(newPage)
                          }
                        }}
                      />
                    </div>
                  </div>
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
                        return (
                          <div class="p-4 bg-white rounded-lg shadow hover:shadow-md transition-shadow">
                            <div class="mb-2">
                              <h4 class="font-semibold text-lg">{article.articleTitle}</h4>
                              <p class="text-sm text-gray-600">
                                {article.articleCreatedAt
                                  ? format(article.articleCreatedAt, 'yyyy-MM-dd')
                                  : 'No date provided'}
                              </p>
                              <a
                                href={getArticleUrl(article.articleId)}
                                target="_blank"
                                rel="noopener noreferrer"
                                class="text-blue-600 hover:underline"
                              >
                                {article.articleId}
                              </a>
                              <p class="text-sm text-gray-600">ID: {article.id}</p>
                            </div>

                            <Show when={article.articleSummary}>
                              <p class="text-gray-700 mb-3">{article.articleSummary}</p>
                            </Show>

                            <div class="flex gap-4 text-sm">
                              <Show when={article.doi}>
                                <a
                                  href={`https://doi.org/${article.doi}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  class="text-blue-600 hover:underline"
                                >
                                  DOI: {article.doi}
                                </a>
                              </Show>

                              <Show when={article.pubmedId}>
                                <a
                                  href={`https://pubmed.ncbi.nlm.nih.gov/${article.pubmedId}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  class="text-blue-600 hover:underline"
                                >
                                  PMID: {article.pubmedId}
                                </a>
                              </Show>
                            </div>

                            <div class="mt-3 pt-3 border-t">
                              <p class="text-sm text-gray-600">Judgments: {article.judgments?.length || 0}</p>
                              <Show when={article.judgments && article.judgments.length > 0}>
                                <div class="mt-2 flex flex-wrap gap-2">
                                  <For each={article.judgments}>
                                    {(judgment) => {
                                      return (
                                        <span
                                          class={`px-2 py-1 text-xs rounded ${
                                            judgment.answeredOriginal
                                              ? 'bg-green-100 text-green-800'
                                              : 'bg-red-100 text-red-800'
                                          }`}
                                        >
                                          {judgment.answeredOriginal ? 'Original' : 'Not Original'}
                                        </span>
                                      )
                                    }}
                                  </For>
                                </div>
                              </Show>
                            </div>
                          </div>
                        )
                      }}
                    </For>
                  </div>
                </Show>

                <Show when={totalPages > 1}>
                  <div class="flex items-center justify-center gap-2 p-4 bg-white rounded-lg shadow">
                    <button
                      class="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 border border-gray-300 rounded-md hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
                      disabled={page <= 1}
                      onClick={() => {
                        return handlePageChange(page - 1)
                      }}
                    >
                      Previous
                    </button>

                    <span class="mx-4 text-sm text-gray-700">
                      Page {page} of {totalPages}
                    </span>

                    <button
                      class="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 border border-gray-300 rounded-md hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
                      disabled={page >= totalPages}
                      onClick={() => {
                        return handlePageChange(page + 1)
                      }}
                    >
                      Next
                    </button>
                  </div>
                </Show>
              </div>
            )
          }}
        </Show>
      </div>
    </Suspense>
  )
}
