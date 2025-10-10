import {useQuery} from '@tanstack/solid-query'
import {type JSX, Show, Suspense} from 'solid-js'

import {apiClient} from '../../services/apiClient.ts'
import {handleApiResponse} from '../../services/utils/handleApiResponse'
import {ArticlesTableTable} from './articlesTable/articlesTableTable.tsx'

const fetchLatestArticles = async () => {
  const response = await apiClient.api.articles.latest.get()
  const result = handleApiResponse(response, 'Failed to fetch articles')
  return result?.data || []
}

export const ArticlesTable = (): JSX.Element => {
  const articlesQuery = useQuery(() => {
    return {
      queryKey: ['articles', 'latest'],
      queryFn: fetchLatestArticles,
      refetchInterval: 30 * 1000, // Refetch every minute
      refetchIntervalInBackground: true,
    }
  })

  return (
    <Suspense>
      <div class="space-y-4">
        <div>
          <h2 class="text-2xl font-bold tracking-tight">Articles</h2>
        </div>
        <Show when={articlesQuery.isLoading}>
          <p class="text-muted-foreground">Loading articles...</p>
        </Show>
        <Show when={articlesQuery.isError}>
          <p class="text-red-600">Failed to load latest articles</p>
        </Show>
        <ArticlesTableTable articles={articlesQuery.data || []} />
      </div>
    </Suspense>
  )
}
