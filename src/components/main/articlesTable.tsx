import {type} from 'arktype'
import {createSignal, type JSX, onMount} from 'solid-js'

import {getSupabaseClient} from '../../utils/getSupabaseClient.ts'
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
      const supabase = getSupabaseClient()
      const {data, error} = await supabase
        .from('2025_July')
        .select('*')
        .in('article_judged_as_ai', ['yes', 'unsure'])
        .in('article_judged_as_ai_agent', ['yes', 'unsure'])
        .in('article_judged_as_healthcare', ['yes', 'unsure'])
        .order('created_at', {ascending: false})
        .limit(200)

      if (error) throw error

      const rows = data as unknown[]
      const asserted = ArticleRows.assert(rows)
      setArticles(asserted)
    } catch (err) {
      console.error('Failed to fetch latest articles from 2025_July', err)
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

      {isLoadingArticles() && (
        <p class="text-muted-foreground">Loading articles...</p>
      )}
      {articlesError() && <p class="text-red-600">{articlesError()}</p>}

      <ArticlesTableArticlesTable articles={articles()} />
    </div>
  )
}
