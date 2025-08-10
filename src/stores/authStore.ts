import type {User} from 'better-auth'
import {createSignal} from 'solid-js'

import {authClient} from '../app/lib/auth-client'

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
    setIsLoading(false)
  }

  // Listen for auth changes using the useSession hook
  authClient.$subscribe('sessionUpdate', (ctx) => {
    if (ctx.session) {
      setSession({user: ctx.session.user, session: ctx.session.session})
      setUser(ctx.session.user)
    } else {
      setSession(null)
      setUser(null)
    }
    setIsLoading(false)
  })
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

// Export auth store
export const authStore = {
  // State
  user,
  session,
  isLoading,

  // Computed
  isAuthenticated: () => {
    return !!user()
  },

  // Actions
  initialize: initializeAuth,
  signOut,
  cleanup,
}
