import {useQuery} from '@tanstack/solid-query'
import {createFileRoute} from '@tanstack/solid-router'
import {format} from 'date-fns'
import {createSignal, For, Show, Suspense} from 'solid-js'

import {fetchArticlesSearch} from '../../../../services/articlesService'

const AdminArticles = () => {
  const [searchTerm, setSearchTerm] = createSignal('')

  const articles = useQuery(() => {
    return {
      queryKey: ['articles', 'search', searchTerm()],
      queryFn: () => {
        return fetchArticlesSearch(searchTerm())
      },
      enabled: searchTerm().length > 0,
      retry: false,
    }
  })

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto">
      <div class="flex justify-between items-center mb-6">
        <h1 class="text-2xl font-bold">Article Search</h1>
      </div>

      <div class="space-y-4">
        {/* Search Bar */}
        <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <input
            type="text"
            placeholder="Search by ID (Internal/External) or Title..."
            value={searchTerm()}
            onInput={(e) => {
              return setSearchTerm(e.currentTarget.value)
            }}
            class="w-full px-3 py-2 border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <Suspense fallback={<div>Loading...</div>}>
          <div class="overflow-x-auto bg-white rounded-lg shadow">
            <table class="min-w-full divide-y divide-gray-200">
              <thead class="bg-gray-50">
                <tr>
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Title</th>
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Authors
                  </th>
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">IDs</th>
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Created At
                  </th>
                </tr>
              </thead>
              <tbody class="bg-white divide-y divide-gray-200">
                <For each={articles.data}>
                  {(article) => {
                    return (
                      <tr class="hover:bg-gray-50">
                        <td class="px-6 py-4">
                          <div class="text-sm font-medium text-gray-900 line-clamp-2" title={article.articleTitle}>
                            {article.articleTitle}
                          </div>
                        </td>
                        <td class="px-6 py-4">
                          <div class="text-sm text-gray-500 line-clamp-1" title={article.articleAuthors?.join(', ')}>
                            {article.articleAuthors?.join(', ')}
                          </div>
                        </td>
                        <td class="px-6 py-4 whitespace-nowrap text-xs text-gray-500">
                          <div>
                            <span class="font-semibold">Int:</span> {article.id}
                          </div>
                          <Show when={article.articleId}>
                            <div>
                              <span class="font-semibold">Ext:</span> {article.articleId}
                            </div>
                          </Show>
                        </td>
                        <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                          {article.createdAt ? format(new Date(article.createdAt), 'yyyy-MM-dd') : '-'}
                        </td>
                      </tr>
                    )
                  }}
                </For>
                <Show
                  when={
                    !articles.isLoading && (!articles.data || articles.data.length === 0) && searchTerm().length > 0
                  }
                >
                  <tr>
                    <td colspan="4" class="px-6 py-4 text-center text-gray-500">
                      No articles found
                    </td>
                  </tr>
                </Show>
                <Show when={searchTerm().length === 0}>
                  <tr>
                    <td colspan="4" class="px-6 py-4 text-center text-gray-500">
                      Enter a search term to find articles
                    </td>
                  </tr>
                </Show>
              </tbody>
            </table>
          </div>
        </Suspense>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/admin/articles/')({component: AdminArticles})
