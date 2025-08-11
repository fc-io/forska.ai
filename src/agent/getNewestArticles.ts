import {type} from 'arktype'

import {getSupabaseClient} from '../utils/getSupabaseClient'

// Extended database item type that includes judged_as fields
const ExtendedDatabaseItem = type({
  id: 'string',

  article_authors: 'string',
  article_created: 'string',
  article_id: 'string',

  article_judged_as_ai_agent_explanation: 'string | null',
  article_judged_as_ai_agent_quote: 'string | null',
  article_judged_as_ai_agent: 'string',

  article_judged_as_ai_explanation: 'string | null',
  article_judged_as_ai_quote: 'string | null',
  article_judged_as_ai: 'string',

  article_judged_as_healthcare_explanation: 'string | null',
  article_judged_as_healthcare_quote: 'string[] | null',
  article_judged_as_healthcare: 'string',
  article_summary: 'string',
  article_title: 'string',
  article_updated: 'string',
  article_url: 'string | null',
  article_version: 'string',
  arxiv_id: 'string',
  created_at: 'string',
  doi: 'string | null',
  publication_status: 'string | null',
  pubmed_id: 'string | null',
  updated_at: 'string',
})

type ExtendedDatabaseItemType = typeof ExtendedDatabaseItem.infer

const getNewestArticles = async ({
  numberOfArticlesToGet,
}: {
  numberOfArticlesToGet: number
}): Promise<ExtendedDatabaseItemType[]> => {
  const supabase = getSupabaseClient()

  const {data, error} = await supabase
    .from('2025_July')
    .select('*')
    .eq('article_judged_as_ai_agent', 'undecided')
    .order('article_updated', {ascending: false})
    .limit(numberOfArticlesToGet)

  if (error) {
    throw new Error(`Failed to fetch articles: ${error.message}`)
  }

  return data as ExtendedDatabaseItemType[]
}

export {ExtendedDatabaseItem, type ExtendedDatabaseItemType, getNewestArticles}
