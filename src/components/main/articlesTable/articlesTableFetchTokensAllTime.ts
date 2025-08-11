import {apiClient} from '../../../services/apiClient.ts'

export const fetchTokensAllTime = async (): Promise<string> => {
  try {
    const response = await apiClient.api.tokens.get()

    if (response.error || response.data?.error) {
      console.error(
        'Error fetching lifetime token use:',
        response.error || response.data?.error,
      )
      return ''
    }

    const {totalPromptTokens, totalCompletionTokens} = response.data || {
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
    }

    return `Total tokens (all time): input ${totalPromptTokens || 0}, output ${totalCompletionTokens || 0}`
  } catch (err) {
    console.error('Error fetching lifetime token use:', err)
    return ''
  }
}
