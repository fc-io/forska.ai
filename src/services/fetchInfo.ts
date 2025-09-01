import {addDays, startOfDay} from 'date-fns'

import {formatNumber} from '../utils/formatNumber.ts'
import {apiClient} from './apiClient.ts'

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

export const fetchTokensAllTime = async (): Promise<string> => {
  try {
    const response = await apiClient.api.tokens.get({query: {}})

    if (response.error) {
      console.error('Error fetching all-time token usage:', response.error)
      return ''
    }

    if (response.data?.error) {
      console.error('Server error:', response.data.error)
      return ''
    }
    // return `Total tokens (last 10m): input ${totalPromptTokens || 0}, output ${totalCompletionTokens || 0}`
    // return `Total tokens (today): input ${totalPromptTokens || 0}, output ${totalCompletionTokens || 0}`

    return `Total tokens (all time): input ${formatNumber(response.data?.totalPromptTokens || 0)}, output ${formatNumber(response.data?.totalCompletionTokens || 0)}`
  } catch (err) {
    console.error('Error fetching lifetime token use:', err)
    return ''
  }
}

export const fetchUnassessedCount = async (): Promise<number | null> => {
  try {
    const response = await apiClient.api['unassessed-count'].get()

    if (response.error) {
      console.error('Error fetching unassessed count:', response.error)
      return null
    }

    if (response.data?.error) {
      console.error('Server error:', response.data.error)
      return null
    }

    return response.data?.count ?? null
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
