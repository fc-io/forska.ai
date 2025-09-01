import {addDays, startOfDay} from 'date-fns'

import {apiClient} from '../../../services/apiClient.ts'
import {formatNumber} from '../../../utils/formatNumber.ts'

export const fetchTokenUseToday = async (): Promise<string> => {
  try {
    const start = startOfDay(new Date())
    const end = startOfDay(addDays(new Date(), 1)) // there is an arguments for why this is better than endOfDay

    const response = await apiClient.api.tokens.get({
      query: {startTime: start.toISOString(), endTime: end.toISOString()},
    })

    if (response.error || response.data?.error) {
      console.error(
        'Error fetching token use:',
        response.error || response.data?.error,
      )
      return ''
    }

    const {totalPromptTokens, totalCompletionTokens} = response.data || {
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
    }

    return `Total tokens (today): input ${formatNumber(totalPromptTokens || 0)}, output ${formatNumber(totalCompletionTokens || 0)}`
  } catch (err) {
    console.error('Error fetching token use:', err)
    return ''
  }
}
