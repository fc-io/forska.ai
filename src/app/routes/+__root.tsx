import type {QueryClient} from '@tanstack/solid-query'
import {useQuery, useQueryClient} from '@tanstack/solid-query'
import {createRootRoute, Outlet, useLocation, useNavigate} from '@tanstack/solid-router'
import {createEffect, Show, Suspense} from 'solid-js'

import {Login} from '../../components/login'
import {Navigation} from '../../components/Navigation'
import {fetchSession} from '../../services/fetchSession'
import {authClient} from '../lib/auth-client'

const sessionQueryKey = ['session'] as const

const signOut = async (queryClient: QueryClient) => {
  const previousSession = queryClient.getQueryData<Awaited<ReturnType<typeof fetchSession>>>(sessionQueryKey)
  queryClient.setQueryData(sessionQueryKey, null)
  return authClient.signOut().then(
    () => {
      return queryClient.invalidateQueries({queryKey: sessionQueryKey})
    },
    (error) => {
      queryClient.setQueryData(sessionQueryKey, previousSession)
      console.error('Error signing out:', error)
      throw error
    },
  )
}
const RootComponent = () => {
  console.log('import.meta.env.DEV', import.meta.env.DEV)
  const queryClient = useQueryClient()
  const location = useLocation()
  const navigate = useNavigate()
  const sessionQuery = useQuery(() => {
    return {
      queryKey: sessionQueryKey,
      queryFn: fetchSession,
      staleTime: 1000 * 60 * 5, // Consider data fresh for 5 minutes
      refetchInterval: 1000 * 60 * 5, // Refetch every 5 minutes
      refetchIntervalInBackground: true,
      refetchOnWindowFocus: true,
    }
  })
  createEffect(() => {
    const user = sessionQuery.data?.user
    const pathname = location().pathname
    if (user && pathname === '/login') {
      void navigate({to: '/'})
    }
  })
  return (
    <>
      <Suspense
        fallback={
          <div class="min-h-screen bg-gray-50 flex items-center justify-center">
            <div class="flex items-center space-x-2">
              <svg class="animate-spin h-6 w-6 text-blue-600" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none" />
                <path
                  class="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              <span class="text-gray-600">Loading...</span>
            </div>
          </div>
        }
      >
        <Show when={!!sessionQuery.data?.user && location().pathname !== '/login'} fallback={<Login />}>
          <Navigation
            user={sessionQuery.data?.user}
            onSignOut={() => {
              return void signOut(queryClient)
            }}
          />
        </Show>
        <Outlet />
      </Suspense>
    </>
  )
}

export const Route = createRootRoute({component: RootComponent})
