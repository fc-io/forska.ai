import {apiClient} from './apiClient.ts'

export const fetchUsers = async () => {
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

export const updateUserProfile = async (userId: string, input: {name: string; openalexMailto: string | null}) => {
  try {
    const response = await apiClient.api.users({id: userId}).patch(input)

    if (response.error || !response.data?.data) {
      console.error('Error updating user:', response.error)
      throw new Error('Failed to update user profile')
    }

    return response.data.data
  } catch (err) {
    console.error('Error updating user profile:', err)
    throw err
  }
}
