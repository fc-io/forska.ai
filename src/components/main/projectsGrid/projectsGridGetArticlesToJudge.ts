// import {type} from 'arktype'

export const getNewestArticlesToJudge = async ({
  numberOfArticlesToGet,
  projectId,
}: {
  numberOfArticlesToGet: number
  projectId: string
}) => {
  console.log('getNewestArticlesToJudge', projectId, numberOfArticlesToGet)
  
  return []
}
// const supabase = getSupabaseClient()
// const {data, error} = await supabase
//   .from('2025_July')
//   .select('*')
//   .eq('article_judged_as_ai_agent', 'undecided')
//   .order('article_updated', {ascending: false})
//   .limit(numberOfArticlesToGet)
// if (error) {
//   throw new Error(`Failed to fetch articles: ${error.message}`)
// }
// return data as ExtendedDatabaseItemType[]
