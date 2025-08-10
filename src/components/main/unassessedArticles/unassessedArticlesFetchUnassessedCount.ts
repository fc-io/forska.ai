import {treaty} from '@elysiajs/eden'

import type {App} from '../../../server/index.ts'

const client = treaty<App>('http://localhost:3000')

export const fetchUnassessedCount = async (): Promise<number | null> => {
  try {
    const response = await client.api['unassessed-count'].get()

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
