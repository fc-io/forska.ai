import {useQuery} from '@tanstack/solid-query'
import {format} from 'date-fns'
import {type JSX, Show} from 'solid-js'

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

  const formatTimestamp = (date: Date | null) => {
    if (!date) return ''
    return format(date, 'HH:mm')
  }

  const invoices = [
    {
      id: 'ART001',
      title: 'Efficient Transformers for Long-Sequence Modeling',
      authors: ['A. Researcher', 'B. Scientist'],
      source: 'arXiv',
      created_at: '2025-07-31T09:15:00Z',
    },
    {
      id: 'ART002',
      title: 'A Comprehensive Review of Graph Neural Networks',
      authors: 'C. Analyst; D. Engineer',
      source: 'PubMed',
      created_at: '2025-07-30T18:42:00Z',
    },
    {
      id: 'ART003',
      title: 'Self-Supervised Learning in Computer Vision',
      authors: ['E. Developer'],
      source: 'Nature',
      created_at: '2025-07-29T12:00:00Z',
    },
    {
      id: 'ART004',
      title: 'Scaling Laws Revisited',
      authors: 'F. Theorist',
      source: 'arXiv',
      created_at: '2025-07-28T07:30:00Z',
    },
    {
      id: 'ART005',
      title: 'Large Language Models in Healthcare',
      authors: ['G. Medic', 'H. Data'],
      source: 'BMJ',
      created_at: '2025-07-27T21:10:00Z',
    },
  ]

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
      <UnassessedArticlesTable articles={invoices} />
    </div>
  )
}
