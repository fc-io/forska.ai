import type {User} from 'better-auth'

import {authClient} from '../app/lib/auth-client'

const getAuthSession = async () => {
  const {data, error} = await authClient.getSession()

  if (error) {
    console.error('Error getting session:', error)
    return null
  }

  return data
}

const getAuthenticatedUser = async (): Promise<User> => {
  const session = await getAuthSession()

  if (!session?.user) {
    throw new Error('User not authenticated')
  }

  return session.user
}

const getSupabaseClient = () => {
  console.warn(
    'getSupabaseClient is deprecated. Use Better Auth methods instead.',
  )
  return null
}

export {getAuthenticatedUser, getAuthSession, getSupabaseClient}
