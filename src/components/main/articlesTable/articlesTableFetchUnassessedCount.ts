import {getSupabaseClient} from '../../../utils/getSupabaseClient.ts'

export const fetchUnassessedCount = async (): Promise<number | null> => {
  try {
    const supabase = getSupabaseClient()
    const {count, error} = await supabase
      .from('2025_July')
      .select('*', {count: 'exact', head: true})
      .eq('article_judged_as_ai_agent', 'undecided')

    if (error) {
      console.error('Error fetching unassessed count:', error)
      return null
    }

    return count || 0
  } catch (err) {
    console.error('Error fetching unassessed articles count:', err)
    return null
  }
}
