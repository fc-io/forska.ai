import {treaty} from '@elysiajs/eden'

import type {App} from '../../../server/index.ts'
import {Tokens} from './unassessedArticlesTypes.ts'

const client = treaty<App>('http://localhost:3000')

export const fetchTokensAllTime = async (): Promise<string> => {
  try {
    const response = await client.api.tokens.get()

    if (response.error) {
      console.error('Error fetching all-time token usage:', response.error)
      return ''
    }

    if (response.data?.error) {
      console.error('Server error:', response.data.error)
      return ''
    }

    const {totalPromptTokens, totalCompletionTokens} = Tokens.assert(
      response.data,
    )
    // return `Total tokens (last 10m): input ${totalPromptTokens || 0}, output ${totalCompletionTokens || 0}`
    // return `Total tokens (today): input ${totalPromptTokens || 0}, output ${totalCompletionTokens || 0}`

    return `Total tokens (all time): input ${totalPromptTokens || 0}, output ${totalCompletionTokens || 0}`
  } catch (err) {
    console.error('Error fetching lifetime token use:', err)
    return ''
  }
}
