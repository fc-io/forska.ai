import type {User} from 'better-auth'
import type {Accessor} from 'solid-js'
import {createResource} from 'solid-js'

import {authClient} from '../app/lib/auth-client'

type UserWithRole = User & {role?: string | null}

const hasRole = (value: User | null): value is UserWithRole => {
  return !!value && 'role' in value
}

type SessionInfo = {
  user: User
  session: {id: string; userId: string; expiresAt: Date}
}

// Fetch session using createResource
const fetchSession = async (): Promise<SessionInfo | null> => {
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

// Use createResource for session management
const [session, {mutate: setSession, refetch: refetchSession}] =
  createResource(fetchSession)

// Derived signals
const user = () => {
  return session()?.user || null
}
const isLoading = () => {
  return session.loading
}
const isAuthenticated = () => {
  return !!session()?.user
}
const isAdmin = () => {
  const currentUser = user()
  return hasRole(currentUser) && currentUser.role === 'admin'
}

// Auth actions
const signOut = async () => {
  try {
    await authClient.signOut()
    setSession(null)
  } catch (error) {
    console.error('Error signing out:', error)
    throw error
  }
}

const cleanup = () => {
  // Better Auth cleanup if needed
  // The subscription is handled internally by authClient
}

type AuthStore = {
  user: () => User | null
  session: Accessor<SessionInfo | null | undefined>
  isLoading: () => boolean
  isAuthenticated: () => boolean
  isAdmin: () => boolean
  refetch: () => SessionInfo | Promise<SessionInfo | null | undefined> | null | undefined
  signOut: () => Promise<void>
  cleanup: () => void
}

// Export auth store
export const authStore: AuthStore = {
  // State
  user,
  session,
  isLoading,

  // Computed
  isAuthenticated,
  isAdmin,

  // Actions
  refetch: refetchSession,
  signOut,
  cleanup,
}
