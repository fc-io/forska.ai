import type {User} from 'better-auth'
import type {Accessor} from 'solid-js'
import {createSignal} from 'solid-js'

import {authClient} from '../app/lib/auth-client'

type UserWithRole = User & {role?: string | null}

const hasRole = (value: User | null): value is UserWithRole => {
  return !!value && 'role' in value
}

// Auth state signals
const [user, setUser] = createSignal<User | null>(null)
const [session, setSession] = createSignal<{
  user: User
  session: {id: string; userId: string; expiresAt: Date}
} | null>(null)
const [isLoading, setIsLoading] = createSignal(true)

// Initialize auth state
const initializeAuth = async () => {
  try {
    const {data, error} = await authClient.getSession()

    if (error) {
      console.error('Error getting session:', error)
      setSession(null)
      setUser(null)
    } else if (data) {
      setSession(data)
      setUser(data.user)
    }
  } catch (error) {
    console.error('Error initializing auth:', error)
  } finally {
    try {
      setIsLoading(false)
    } catch (error) {
      console.error('Error getting session:', error)
    }
  }
}

// Auth actions
const signOut = async () => {
  try {
    await authClient.signOut()
    setSession(null)
    setUser(null)
  } catch (error) {
    console.error('Error signing out:', error)
    throw error
  }
}

const cleanup = () => {
  // Better Auth cleanup if needed
  // The subscription is handled internally by authClient
}

type SessionInfo = {
  user: User
  session: {id: string; userId: string; expiresAt: Date}
}

type AuthStore = {
  user: Accessor<User | null>
  session: Accessor<SessionInfo | null>
  isLoading: Accessor<boolean>
  isAuthenticated: () => boolean
  isAdmin: () => boolean
  initialize: () => Promise<void>
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
  isAuthenticated: () => {
    return !!user()
  },
  isAdmin: () => {
    const currentUser = user()
    return hasRole(currentUser) && currentUser.role === 'admin'
  },

  // Actions
  initialize: initializeAuth,
  signOut,
  cleanup,
}
