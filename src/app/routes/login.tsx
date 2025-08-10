import {createFileRoute, useNavigate} from '@tanstack/solid-router'
import {createSignal, type JSX, Show} from 'solid-js'

import {authStore} from '../../stores/authStore'
import {authClient} from '../lib/auth-client'

const Login = (): JSX.Element => {
  const [email, setEmail] = createSignal('')
  const [password, setPassword] = createSignal('')
  const [isLoading, setIsLoading] = createSignal(false)
  const [error, setError] = createSignal('')
  const [isSignUp, setIsSignUp] = createSignal(false)
  const navigate = useNavigate()

  const handleSubmit = async (e: Event) => {
    e.preventDefault()
    setIsLoading(true)
    setError('')

    try {
      if (isSignUp()) {
        const {error} = await authClient.signUp.email({
          email: email(),
          password: password(),
        })

        if (error) throw error
        // After signup, automatically sign in
        const {error: signInError} = await authClient.signIn.email({
          email: email(),
          password: password(),
        })
        
        if (signInError) throw signInError
        // Navigate to home on successful login
        void navigate({to: '/'})
      } else {
        const {error} = await authClient.signIn.email({
          email: email(),
          password: password(),
        })

        if (error) throw error
        // Navigate to home on successful login
        void navigate({to: '/'})
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <Show
      when={!authStore.isLoading() && !authStore.isAuthenticated()}
      fallback={
        <div class="min-h-screen bg-background text-foreground flex items-center justify-center p-4">
          <div class="w-full max-w-md space-y-8 text-center">
            <h1 class="text-3xl font-bold tracking-tight">Already Logged In</h1>
            <p class="text-muted-foreground">You are already authenticated.</p>
            <button
              onClick={() => {
                void navigate({to: '/'})
              }}
              class="w-full bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-10 items-center justify-center whitespace-nowrap rounded-md px-4 py-2 text-sm font-medium"
            >
              Go to Dashboard
            </button>
          </div>
        </div>
      }
    >
      <div class="min-h-screen bg-background text-foreground flex items-center justify-center p-4">
        <div class="w-full max-w-md space-y-8">
          <div class="text-center">
            <h1 class="text-3xl font-bold tracking-tight">
              {isSignUp() ? 'Create Account' : 'Sign In'}
            </h1>
            <p class="text-muted-foreground mt-2">
              {isSignUp()
                ? 'Create an account to access Paper Agent'
                : 'Sign in to your Paper Agent account'}
            </p>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault()
              void handleSubmit(e)
            }}
            class="space-y-6"
          >
            <div>
              <label for="email" class="block text-sm font-medium mb-2">
                Email address
              </label>
              <input
                id="email"
                type="email"
                required
                value={email()}
                onInput={(e) => {
                  return setEmail(e.currentTarget.value)
                }}
                class="w-full px-3 py-2 border border-input rounded-md bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
                placeholder="Enter your email"
              />
            </div>

            <div>
              <label for="password" class="block text-sm font-medium mb-2">
                Password
              </label>
              <input
                id="password"
                type="password"
                required
                value={password()}
                onInput={(e) => {
                  return setPassword(e.currentTarget.value)
                }}
                class="w-full px-3 py-2 border border-input rounded-md bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
                placeholder="Enter your password"
              />
            </div>

            {error() && (
              <div class="text-destructive text-sm font-medium">{error()}</div>
            )}

            <button
              type="submit"
              disabled={isLoading()}
              class="w-full bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-10 items-center justify-center whitespace-nowrap rounded-md px-4 py-2 text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
            >
              {isLoading() ? (
                <div class="flex items-center space-x-2">
                  <svg class="animate-spin h-4 w-4" viewBox="0 0 24 24">
                    <circle
                      class="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      stroke-width="4"
                      fill="none"
                    />
                    <path
                      class="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                  <span>
                    {isSignUp() ? 'Creating account...' : 'Signing in...'}
                  </span>
                </div>
              ) : isSignUp() ? (
                'Create Account'
              ) : (
                'Sign In'
              )}
            </button>
          </form>

          <div class="text-center">
            <button
              type="button"
              onClick={() => {
                setIsSignUp(!isSignUp())
                setError('')
              }}
              class="text-primary hover:text-primary/80 text-sm font-medium"
            >
              {isSignUp()
                ? 'Already have an account? Sign in'
                : "Don't have an account? Sign up"}
            </button>
          </div>
        </div>
      </div>
    </Show>
  )
}

export const Route = createFileRoute('/login')({component: Login})
