import {useQuery} from '@tanstack/solid-query'
import {format} from 'date-fns'
import {type JSX, Show, For} from 'solid-js'

import {apiClient} from '../../services/apiClient.ts'
// import {fetchLatestArticles} from '../../services/articlesService.ts'
import {fetchInfo} from '../../services/fetchInfo'
import {handleApiResponse} from '../../services/utils/handleApiResponse'
import {infoState} from '../../stores/info.ts'
import {formatNumber} from '../../utils/formatNumber.ts'
import {UnassessedArticlesTable} from './unassessedArticles/unassessedArticlesTable.tsx'

const fetchLatestArticles = async () => {
  const response = await apiClient.api.articles.latest.get()
  const result = handleApiResponse(response, 'Failed to fetch articles')
  return result?.data || []
}

const fetchArticlesStats = async () => {
  const response = await apiClient.api.articles.stats.get()
  return handleApiResponse(response, 'Failed to fetch article stats')
}

export const UnassessedArticles = (): JSX.Element => {
  const infoQuery = useQuery(() => {
    return {
      queryKey: ['info'],
      queryFn: fetchInfo,
      refetchInterval: 60 * 1000, // Refetch every minute
      refetchIntervalInBackground: true,
    }
  })

  const articlesQuery = useQuery(() => {
    return {
      queryKey: ['articles', 'latest'],
      queryFn: fetchLatestArticles,
      refetchInterval: 30 * 1000, // Refetch every minute
      refetchIntervalInBackground: true,
    }
  })

  const articlesStatsQuery = useQuery(() => {
    return {
      queryKey: ['articles', 'stats'],
      queryFn: fetchArticlesStats,
      refetchInterval: 60 * 1000,
      refetchIntervalInBackground: true,
    }
  })

  const formatTimestamp = (date: Date | null) => {
    if (!date) return ''
    return format(date, 'HH:mm')
  }

  return (
    <div class="space-y-4">
      <div>
        <h2 class="text-2xl font-bold tracking-tight">Latest Articles</h2>
        <div class="border-t border-gray-400 md:border-t-0 md:border-l border-l-gray-400 p-4 mt-4">
          <Show
            when={!infoQuery.isLoading}
            fallback={<p class="text-muted-foreground">'Loading unassessed articles count...'</p>}
          >
            <p class="text-muted-foreground">
              {`${formatNumber(infoQuery.data?.unassessedCount)} unassessed articles`}
            </p>
          </Show>
          <Show when={!articlesStatsQuery.isLoading}>
            <p class="text-muted-foreground">
              {`Total articles: ${formatNumber(articlesStatsQuery.data?.total || 0)}`}
            </p>
            <p class="text-muted-foreground">
              {`Articles without import route link: ${formatNumber(articlesStatsQuery.data?.unlinkedCount || 0)}`}
            </p>
            <div class="mt-1">
              <p class="text-muted-foreground">By import route:</p>
              <ul class="list-disc list-inside text-muted-foreground">
                <For each={articlesStatsQuery.data?.byImportRoute || []}>
                  {(r) => (
                    <li>
                      <span class="font-mono">{r.importRoute ?? 'Not set'}</span>: {formatNumber(r.count || 0)}
                    </li>
                  )}
                </For>
              </ul>
            </div>
          </Show>
          {/* <p class="text-muted-foreground">
            {infoQuery.data?.tokenUseLast10Minutes}
          </p> */}
          <p class="text-muted-foreground">{infoQuery.data?.tokenUseToday}</p>
          <p class="text-muted-foreground">{infoQuery.data?.tokenUseLifetime}</p>
          <p class="text-muted-foreground">
            {infoState.lastUpdated ? `Last updated: ${formatTimestamp(infoState.lastUpdated)}` : ''}
          </p>
        </div>
      </div>
      <UnassessedArticlesTable articles={articlesQuery.data || []} />
    </div>
  )
}
