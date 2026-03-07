import type {QueryClient} from '@tanstack/solid-query'
import {useQuery, useQueryClient} from '@tanstack/solid-query'
import {createRootRoute, Outlet, useLocation, useNavigate} from '@tanstack/solid-router'
import {createEffect, Show} from 'solid-js'

import {Navigation} from '../../components/Navigation'
import {fetchSession} from '../../services/fetchSession'
import {localSession} from '../../utils/localUser.ts'
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
      return null
    },
  )
}

const normalizePathname = (pathname: string) => {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
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
      suspense: false,
    }
  })
  createEffect(() => {
    const user = sessionQuery.data?.user
    const pathname = normalizePathname(location().pathname)
    const isReady = !sessionQuery.isLoading && !sessionQuery.isFetching
    const isLoginRoute = pathname === '/login'
    const shouldRedirectToHome = isReady && Boolean(user) && isLoginRoute
    const shouldRedirectToLogin = isReady && !user && !isLoginRoute

    shouldRedirectToHome ? void navigate({to: '/'}) : shouldRedirectToLogin ? void navigate({to: '/login'}) : null
  })

  const isLoginRoute = () => {
    return normalizePathname(location().pathname) === '/login'
  }

  return (
    <>
      <Show when={!isLoginRoute()}>
        <Navigation
          user={sessionQuery.data?.user ?? localSession.user}
          onSignOut={() => {
            return void signOut(queryClient)
          }}
        />
      </Show>
      <Outlet />
    </>
  )
}

export const Route = createRootRoute({component: RootComponent})
