import {apiClient} from '../../../services/apiClient.ts'

export const fetchTokenUseLast10Minutes = async (): Promise<string> => {
  try {
    const now = new Date()
    const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000)

    const response = await apiClient.api.tokens.get({
      query: {
        startTime: tenMinutesAgo.toISOString(),
        endTime: now.toISOString(),
      },
    })

    if (response.error || response.data?.error) {
      console.error(
        'Error fetching last 10 minutes token use:',
        response.error || response.data?.error,
      )
      return ''
    }

    const {totalPromptTokens, totalCompletionTokens} = response.data || {
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
    }

    return `Total tokens (last 10m): input ${totalPromptTokens || 0}, output ${totalCompletionTokens || 0}`
  } catch (err) {
    console.error('Error fetching last 10 minutes token use:', err)
    return ''
  }
}
