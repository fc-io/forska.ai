import {useQuery} from '@tanstack/solid-query'
import {format} from 'date-fns'
import {type JSX, Show} from 'solid-js'

import {fetchLatestArticles} from '../../services/articlesService.ts'
import {fetchInfo} from '../../services/fetchInfo'
import {infoState} from '../../stores/info.ts'
import {UnassessedArticlesTable} from './unassessedArticles/unassessedArticlesTable.tsx'

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
      refetchInterval: 60 * 1000, // Refetch every minute
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
            fallback={
              <p class="text-muted-foreground">
                'Loading unassessed articles count...'
              </p>
            }
          >
            <p class="text-muted-foreground">
              {`${infoQuery.data?.unassessedCount} unassessed articles`}
            </p>
          </Show>
          {/* <p class="text-muted-foreground">
            {infoQuery.data?.tokenUseLast10Minutes}
          </p> */}
          <p class="text-muted-foreground">{infoQuery.data?.tokenUseToday}</p>
          <p class="text-muted-foreground">
            {infoQuery.data?.tokenUseLifetime}
          </p>
          <p class="text-muted-foreground">
            {infoState.lastUpdated
              ? `Last updated: ${formatTimestamp(infoState.lastUpdated)}`
              : ''}
          </p>
        </div>
      </div>
      <UnassessedArticlesTable articles={articlesQuery.data || []} />
    </div>
  )
}
