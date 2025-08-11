import {apiClient} from '../../../services/apiClient.ts'

export const fetchUnassessedCount = async (): Promise<number | null> => {
  try {
    const response =
      await apiClient.api.articles['unassessed-count-2025-july'].get()

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
