import {addDays, startOfDay} from 'date-fns'

import {getSupabaseClient} from '../../../utils/getSupabaseClient.ts'
import {Tokens} from './unassessedArticlesTypes.ts'

export const fetchTokenUseToday = async (): Promise<string> => {
  try {
    const supabase = getSupabaseClient()
    const start = startOfDay(new Date())
    const end = startOfDay(addDays(new Date(), 1)) // there is an arguments for why this is better than endOfDay

    const {data} = await supabase
      .from('2025_july_token_use')
      .select(
        'totalPromptTokens:total_prompt_tokens.sum(),'
          + 'totalCompletionTokens:total_completion_tokens.sum()',
      )
      .gte('created_at', start.toISOString())
      .lt('created_at', end.toISOString())
      .single()

    const {totalPromptTokens, totalCompletionTokens} = Tokens.assert(data)

    return `Total tokens (today): input ${totalPromptTokens || 0}, output ${totalCompletionTokens || 0}`
  } catch (err) {
    console.error('Error fetching token use:', err)
    return ''
  }
}
