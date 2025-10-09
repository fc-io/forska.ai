import {authClient} from '../app/lib/auth-client'

export const fetchSession = async () => {
  console.log('fetchSession')
  try {
    const {data, error} = await authClient.getSession()
    if (error) {
      console.error('Error getting session:', error)
      return null
    }
    return data || null
  } catch (error) {
    console.error('Error fetching session:', error)
    return null
  }
}
