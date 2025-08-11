import {type} from 'arktype'
import {createSignal, type JSX, onMount, Show} from 'solid-js'

import {apiClient} from '../../services/apiClient.ts'
import {ArticlesTableArticlesTable} from './articlesTable/articlesTableTable.tsx'

// Arktype schema for the exact row structure requested
const ArticleRow = type({
  id: 'string',
  article_id: 'string',
  article_title: 'string',
  article_authors: 'string',
  article_created: 'string',
  article_judged_as_ai: "'yes' | 'unsure' | 'no' | 'undecided'",
  article_judged_as_ai_agent: "'yes' | 'unsure' | 'no' | 'undecided'",
  article_judged_as_healthcare: "'yes' | 'unsure' | 'no' | 'undecided'",
  // source: 'string | null | undefined',
})

export const ArticleRows = type(ArticleRow.array())

export const ArticlesTable = (): JSX.Element => {
  const [articles, setArticles] = createSignal<typeof ArticleRows.infer>([])
  const [isLoadingArticles, setIsLoadingArticles] = createSignal<boolean>(false)
  const [articlesError, setArticlesError] = createSignal<string | null>(null)

  const fetchLatestArticles = async () => {
    setIsLoadingArticles(true)
    setArticlesError(null)
    try {
      const response = await apiClient.api.articles.latest.get()

      if (response.error) {
        throw new Error('Failed to fetch articles')
      }

      if (response.data?.error) {
        throw new Error(response.data.error)
      }

      const rows = response.data?.data || []
      const asserted = ArticleRows.assert(rows)
      setArticles(asserted)
    } catch (err) {
      console.error('Failed to fetch latest articles', err)
      setArticlesError('Failed to load latest articles')
      setArticles([])
    } finally {
      setIsLoadingArticles(false)
    }
  }

  onMount(() => {
    void fetchLatestArticles()
    // const interval = setInterval(() => {
    //   void fetchLatestArticles()
    // }, 60 * 1000)

    // onCleanup(() => {
    //   clearInterval(interval)
    // })
  })

  return (
    <div class="space-y-4">
      <div>
        <h2 class="text-2xl font-bold tracking-tight">Articles</h2>
      </div>

      <Show when={isLoadingArticles()}>
        <p class="text-muted-foreground">Loading articles...</p>
      </Show>
      <Show when={articlesError()}>
        <p class="text-red-600">{articlesError()}</p>
      </Show>

      <ArticlesTableArticlesTable articles={articles()} />
    </div>
  )
}
