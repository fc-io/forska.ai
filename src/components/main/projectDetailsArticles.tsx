import {useQuery} from '@tanstack/solid-query'
import {createSignal, For, Show} from 'solid-js'

import type {articles, judgments} from '../../db/schema'
import {apiClient} from '../../services/apiClient'

type ArticleWithJudgments = typeof articles.$inferSelect & {
  judgments: Array<typeof judgments.$inferSelect>
}

export const ProjectDetailsArticles = (props: {projectId: string}) => {
  const [filterAnsweredOriginal, setFilterAnsweredOriginal] = createSignal<
    boolean | null
  >(null)

  const articlesQuery = useQuery(() => {
    return {
      queryKey: [
        'project-articles-with-judgments',
        props.projectId,
        filterAnsweredOriginal(),
      ],
      queryFn: async () => {
        const queryParams: {answered_original?: string} = {}

        if (filterAnsweredOriginal() !== null) {
          queryParams.answered_original = String(filterAnsweredOriginal())
        }

        const response = await apiClient.api
          .projects({id: props.projectId})
          ['articles-with-judgments'].get({query: queryParams})

        if (response.error || !response.data) {
          throw new Error(
            typeof response.error === 'string'
              ? response.error
              : 'Failed to fetch articles',
          )
        }

        return response.data.data as ArticleWithJudgments[]
      },
    }
  })

  return (
    <div class="space-y-4">
      <div class="flex items-center gap-4 p-4 bg-white rounded-lg shadow">
        <label class="font-medium">Filter by answered_original:</label>
        <select
          class="px-3 py-2 border rounded-md"
          value={
            filterAnsweredOriginal() === null
              ? 'all'
              : String(filterAnsweredOriginal())
          }
          onChange={(e) => {
            const value = e.target.value
            setFilterAnsweredOriginal(value === 'all' ? null : value === 'true')
          }}
        >
          <option value="all">All</option>
          <option value="true">Yes (Original)</option>
          <option value="false">No (Not Original)</option>
        </select>
      </div>

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
        {(articles) => {
          return (
            <div class="space-y-4">
              <div class="p-4 bg-white rounded-lg shadow">
                <h3 class="text-lg font-semibold mb-2">
                  Articles with Complete Judgments ({articles().length})
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

              <Show
                when={articles().length > 0}
                fallback={
                  <div class="p-8 text-center text-gray-500">
                    No articles found with complete judgments
                    {filterAnsweredOriginal() !== null && ' for this filter'}
                  </div>
                }
              >
                <div class="grid gap-4">
                  <For each={articles()}>
                    {(article) => {
                      return (
                        <div class="p-4 bg-white rounded-lg shadow hover:shadow-md transition-shadow">
                          <div class="mb-2">
                            <h4 class="font-semibold text-lg">
                              {article.articleTitle}
                            </h4>
                            <p class="text-sm text-gray-600">
                              ID: {article.id}
                            </p>
                          </div>

                          <Show when={article.articleSummary}>
                            <p class="text-gray-700 mb-3 line-clamp-3">
                              {article.articleSummary}
                            </p>
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
                            <p class="text-sm text-gray-600">
                              Judgments: {article.judgments?.length || 0}
                            </p>
                            <Show
                              when={
                                article.judgments
                                && article.judgments.length > 0
                              }
                            >
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
                                        {judgment.answeredOriginal
                                          ? 'Original'
                                          : 'Not Original'}
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
            </div>
          )
        }}
      </Show>
    </div>
  )
}
