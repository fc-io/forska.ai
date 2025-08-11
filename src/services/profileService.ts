import {apiClient} from './apiClient.ts'

export const fetchProfiles = async () => {
  try {
    const response = await apiClient.api.users.get()

    if (response.error) {
      console.error('Error fetching users:', response.error)
      throw new Error('Failed to fetch users')
    }

    if (!response.data?.data) {
      return []
    }

    return response.data.data
  } catch (err) {
    console.error('Error fetching profiles:', err)
    throw err
  }
}
