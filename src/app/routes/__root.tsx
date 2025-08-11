import {useQuery} from '@tanstack/solid-query'
import {createRootRoute, Link, Outlet} from '@tanstack/solid-router'
import {TanStackRouterDevtools} from '@tanstack/solid-router-devtools'
import {Show} from 'solid-js'

import {AccessRequired} from '../../components/ui/access-required'
import {fetchSession} from '../../services/fetchSession'
import {authClient} from '../lib/auth-client'
// type SessionInfo = {
//   user: User
//   session: {id: string; userId: string; expiresAt: Date}
// }

const signOut = async () => {
  try {
    await authClient.signOut()
    // queryClient.setQueryData(['session'], null)
    // await queryClient.invalidateQueries({queryKey: ['session']})
  } catch (error) {
    console.error('Error signing out:', error)
    throw error
  }
}
const RootComponent = () => {
  console.log('import.meta.env.DEV', import.meta.env.DEV)
  const sessionQuery = useQuery(() => {
    return {
      queryKey: ['session'],
      queryFn: fetchSession,
      staleTime: 1000 * 60 * 5, // Consider data fresh for 5 minutes
      refetchInterval: 1000 * 60 * 5, // Refetch every 5 minutes
      refetchIntervalInBackground: true,
      refetchOnWindowFocus: true,
    }
  })
  // const {user, isLoading, isAuthenticated, isAdmin, signOut} = useSession()

  return (
    <>
      <Show
        when={!sessionQuery.isLoading}
        fallback={
          <div class="min-h-screen bg-background text-foreground flex items-center justify-center">
            <div class="flex items-center space-x-2">
              <svg class="animate-spin h-6 w-6" viewBox="0 0 24 24">
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
              <span>Loading...</span>
            </div>
          </div>
        }
      >
        <Show when={!!sessionQuery.data?.user} fallback={<AccessRequired />}>
          <div class="p-2 flex gap-2">
            <Link to="/" class="[&.active]:font-bold">
              Home
            </Link>{' '}
            <Link to="/articles" class="[&.active]:font-bold">
              Articles
            </Link>
            <Link to="/projects" class="[&.active]:font-bold">
              Projects
            </Link>
            <Link to="/about" class="[&.active]:font-bold">
              About
            </Link>
            <div class="flex items-center space-x-4 ml-auto">
              <Link
                to="/settings"
                class="text-sm text-primary hover:text-primary/80 font-medium"
              >
                Settings
              </Link>
              {/* Admin-only link */}
              <Show when={sessionQuery.data?.user?.role === 'admin'}>
                <Link
                  to="/admin/users"
                  class="text-sm text-primary hover:text-primary/80 font-medium"
                >
                  Users
                </Link>
              </Show>
              <Show when={sessionQuery.data?.user}>
                <span class="text-sm text-muted-foreground">
                  {sessionQuery.data?.user?.email}
                </span>
              </Show>
              <button
                onClick={() => {
                  void signOut()
                  // void sessionQuery.refetch()
                }}
                class="text-primary hover:text-primary/80 text-sm font-medium cursor-pointer"
              >
                Sign Out
              </button>
            </div>
          </div>
          <hr />
        </Show>
        <Outlet />
        <TanStackRouterDevtools />
      </Show>
    </>
  )
}

export const Route = createRootRoute({component: RootComponent})
