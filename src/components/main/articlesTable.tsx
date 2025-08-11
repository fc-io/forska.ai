import {useQuery} from '@tanstack/solid-query'
import {type JSX, Show} from 'solid-js'

import {apiClient} from '../../services/apiClient.ts'
import {ArticlesTableTable} from './articlesTable/articlesTableTable.tsx'

const fetchLatestArticles = async () => {
  const response = await apiClient.api.articles.latest.get()

  if (response.error) {
    throw new Error('Failed to fetch articles')
  }

  if (response.data?.error) {
    throw new Error(response.data.error)
  }

  return response.data?.data || []
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
  )
}
