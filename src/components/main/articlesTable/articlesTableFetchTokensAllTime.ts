import {getSupabaseClient} from '../../../utils/getSupabaseClient.ts'
import {Tokens} from './unassessedArticlesTypes.ts'

export const fetchTokensAllTime = async (): Promise<string> => {
  try {
    const supabase = getSupabaseClient()

    const {data} = await supabase
      .from('2025_july_token_use')
      .select(
        'totalPromptTokens:total_prompt_tokens.sum(),'
          + 'totalCompletionTokens:total_completion_tokens.sum()',
      )
      .single()

    const {totalPromptTokens, totalCompletionTokens} = Tokens.assert(data)

    return `Total tokens (all time): input ${totalPromptTokens || 0}, output ${totalCompletionTokens || 0}`
  } catch (err) {
    console.error('Error fetching lifetime token use:', err)
    return ''
  }
}
