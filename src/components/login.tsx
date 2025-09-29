import {useQueryClient} from '@tanstack/solid-query'
import {useNavigate} from '@tanstack/solid-router'
import {createSignal, type JSX, Show} from 'solid-js'

import {authClient} from '../app/lib/auth-client'

export const Login = (): JSX.Element => {
  const [name, setName] = createSignal('')
  const [email, setEmail] = createSignal('')
  const [password, setPassword] = createSignal('')
  const [showPassword, setShowPassword] = createSignal(false)
  const [isLoading, setIsLoading] = createSignal(false)
  const [error, setError] = createSignal('')
  const [isSignUp, setIsSignUp] = createSignal(false)
  const [acceptTerms, setAcceptTerms] = createSignal(false)
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const handleSubmit = async (e: Event) => {
    e.preventDefault()
    setError('')

    if (isSignUp() && !acceptTerms()) {
      setError('Please accept the terms and conditions')
      return
    }

    setIsLoading(true)

    try {
      if (isSignUp()) {
        const {error} = await authClient.signUp.email({email: email(), password: password(), name: name() || ''})

        if (error) throw error
        // After signup, automatically sign in
        const {error: signInError} = await authClient.signIn.email({email: email(), password: password()})

        if (signInError) throw signInError
        // Invalidate session query to trigger refetch
        await queryClient.invalidateQueries({queryKey: ['session']})
        // Navigate to home on successful login
        void navigate({to: '/'})
      } else {
        const {error} = await authClient.signIn.email({email: email(), password: password()})

        if (error) throw error
        // Invalidate session query to trigger refetch
        await queryClient.invalidateQueries({queryKey: ['session']})
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
    <div class="min-h-screen bg-gray-50 flex flex-col justify-center py-12 sm:px-6 lg:px-8">
      <div class="sm:mx-auto sm:w-full sm:max-w-md">
        <div class="text-center">
          <h2 class="text-3xl font-bold text-gray-900">{isSignUp() ? 'Sign Up' : 'Sign In'}</h2>
        </div>
      </div>

      <div class="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <div class="bg-white py-8 px-4 shadow-sm rounded-lg sm:px-10">
          <form
            onSubmit={(e) => {
              void handleSubmit(e)
            }}
            class="space-y-6"
          >
            <Show when={isSignUp()}>
              <div>
                <input
                  type="text"
                  id="name"
                  value={name()}
                  onInput={(e) => {
                    return setName(e.currentTarget.value)
                  }}
                  placeholder="Full name"
                  required
                  class="appearance-none block w-full px-3 py-3 border border-gray-300 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                />
              </div>
            </Show>

            <div>
              <input
                type="email"
                id="email"
                value={email()}
                onInput={(e) => {
                  return setEmail(e.currentTarget.value)
                }}
                placeholder="Email address"
                required
                class="appearance-none block w-full px-3 py-3 border border-gray-300 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
              />
            </div>

            <div class="relative">
              <input
                type={showPassword() ? 'text' : 'password'}
                id="password"
                value={password()}
                onInput={(e) => {
                  return setPassword(e.currentTarget.value)
                }}
                placeholder="Password"
                required
                class="appearance-none block w-full px-3 py-3 pr-10 border border-gray-300 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
              />
              <button
                type="button"
                onClick={() => {
                  return setShowPassword(!showPassword())
                }}
                class="absolute inset-y-0 right-0 pr-3 flex items-center"
              >
                <svg class="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <Show
                    when={showPassword()}
                    fallback={
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width={2}
                        d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                      />
                    }
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width={2}
                      d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"
                    />
                  </Show>
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width={2}
                    d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                  />
                </svg>
              </button>
            </div>

            <Show when={isSignUp()}>
              <div class="flex items-center">
                <input
                  id="accept-terms"
                  type="checkbox"
                  checked={acceptTerms()}
                  onChange={(e) => {
                    return setAcceptTerms(e.currentTarget.checked)
                  }}
                  class="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                />
                <label for="accept-terms" class="ml-2 block text-sm text-gray-900">
                  I accept the{' '}
                  <a href="#" class="text-blue-600 hover:text-blue-500">
                    terms and conditions
                  </a>
                </label>
              </div>
            </Show>

            <Show when={error()}>
              <div class="text-red-600 text-sm text-center">{error()}</div>
            </Show>

            <div>
              <button
                type="submit"
                disabled={isLoading()}
                class="w-full flex justify-center py-3 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLoading() ? (isSignUp() ? 'Signing up...' : 'Signing in...') : isSignUp() ? 'Sign up' : 'Sign in'}
              </button>
            </div>
          </form>

          <div class="text-center mt-6">
            <button
              type="button"
              onClick={() => {
                setIsSignUp(!isSignUp())
                setError('')
                setAcceptTerms(false)
              }}
              class="text-blue-600 hover:text-blue-500 text-sm font-medium"
            >
              {isSignUp() ? 'Already have an account? Sign in' : "Don't have an account? Sign up"}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
