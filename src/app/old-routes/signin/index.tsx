import {createFileRoute} from '@tanstack/solid-router'
import {createSignal, Show} from 'solid-js'

import {authClient} from '../../lib/auth-client'

const RouteComponent = () => {
  const [email, setEmail] = createSignal('')
  const [password, setPassword] = createSignal('')
  const [showPassword, setShowPassword] = createSignal(false)
  const [isLoading, setIsLoading] = createSignal(false)
  const [error, setError] = createSignal('')

  const handleSubmit = async (e: Event) => {
    e.preventDefault()
    setError('')

    setIsLoading(true)

    try {
      await authClient.signIn.email({email: email(), password: password()})
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'An error occurred during signin',
      )
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div class="min-h-screen bg-gray-50 flex flex-col justify-center py-12 sm:px-6 lg:px-8">
      <div class="sm:mx-auto sm:w-full sm:max-w-md">
        <div class="text-center">
          <h2 class="text-3xl font-bold text-gray-900">Sign In</h2>
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
                <svg
                  class="h-5 w-5 text-gray-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
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

            <div class="flex items-center justify-between">
              <div class="text-sm">
                <a href="/signup" class="text-blue-600 hover:text-blue-500">
                  Need an account? Sign up
                </a>
              </div>
              <div class="text-sm">
                <a href="#" class="text-blue-600 hover:text-blue-500">
                  Forgot password?
                </a>
              </div>
            </div>

            <Show when={error()}>
              <div class="text-red-600 text-sm text-center">{error()}</div>
            </Show>

            <div>
              <button
                type="submit"
                disabled={isLoading()}
                class="w-full flex justify-center py-3 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLoading() ? 'Signing in...' : 'Sign in'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/signin/')({component: RouteComponent})
