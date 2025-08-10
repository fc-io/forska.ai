import {getSupabaseClient} from '../../../utils/getSupabaseClient.ts'
import {Tokens} from './unassessedArticlesTypes.ts'

export const fetchTokenUseLast10Minutes = async (): Promise<string> => {
  try {
    const supabase = getSupabaseClient()
    const now = new Date()
    const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000)

    const {data} = await supabase
      .from('2025_july_token_use')
      .select(
        'totalPromptTokens:total_prompt_tokens.sum(),'
          + 'totalCompletionTokens:total_completion_tokens.sum()',
      )
      .gte('created_at', tenMinutesAgo.toISOString())
      .lt('created_at', now.toISOString())
      .single()

    const {totalPromptTokens, totalCompletionTokens} = Tokens.assert(data)

    return `Total tokens (last 10m): input ${totalPromptTokens || 0}, output ${totalCompletionTokens || 0}`
  } catch (err) {
    console.error('Error fetching last 10 minutes token use:', err)
    return ''
  }
}
