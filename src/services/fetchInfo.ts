import {addDays, startOfDay} from 'date-fns'

import {formatNumber} from '../utils/formatNumber.ts'
import {apiClient} from './apiClient.ts'
import {handleApiResponse} from './utils/handleApiResponse'

export const fetchTokenUseToday = async (): Promise<string> => {
  try {
    const start = startOfDay(new Date())
    const end = startOfDay(addDays(new Date(), 1)) // there is an arguments for why this is better than endOfDay
    const response = await apiClient.api.tokens.get({
      query: {startTime: start.toISOString(), endTime: end.toISOString()},
    })

    const data = handleApiResponse(response, 'Failed to fetch token use')
    const {totalPromptTokens, totalCompletionTokens} = data || {
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
    }

    return `Total tokens (today): input ${formatNumber(totalPromptTokens || 0)}, output ${formatNumber(totalCompletionTokens || 0)}`
  } catch (err) {
    console.error('Error fetching token use:', err)
    return ''
  }
}

export const fetchTokensAllTime = async (): Promise<string> => {
  try {
    const response = await apiClient.api.tokens.get({query: {}})
    const data = handleApiResponse(
      response,
      'Failed to fetch all-time token usage',
    )

    // return `Total tokens (last 10m): input ${totalPromptTokens || 0}, output ${totalCompletionTokens || 0}`
    // return `Total tokens (today): input ${totalPromptTokens || 0}, output ${totalCompletionTokens || 0}`

    return `Total tokens (all time): input ${formatNumber(data?.totalPromptTokens || 0)}, output ${formatNumber(data?.totalCompletionTokens || 0)}`
  } catch (err) {
    console.error('Error fetching lifetime token use:', err)
    return ''
  }
}

export const fetchUnassessedCount = async (): Promise<number | null> => {
  try {
    const response = await apiClient.api['unassessed-count'].get()
    const data = handleApiResponse(response, 'Failed to fetch unassessed count')
    return data?.count ?? null
  } catch (err) {
    console.error('Error fetching unassessed articles count:', err)
    return null
  }
}

export const fetchInfo = async () => {
  const [tokenUseToday, unassessedCount, tokenUseLifetime] = await Promise.all([
    fetchTokenUseToday(),
    fetchUnassessedCount(),
    fetchTokensAllTime(),
  ])

  // setInfoState('tokenUseToday', tokenUseToday)

  // if (unassessedCount !== null) {
  //   setInfoState('unassessedCount', unassessedCount)
  //   setInfoState('lastUpdated', new Date())
  // }

  // setInfoState('tokenUseLifetime', tokenUseLifetime)

  return {
    unassessedCount,
    tokenUseLifetime,
    tokenUseToday,
    lastUpdated: new Date(),
  }
}
