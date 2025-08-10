import {createRootRoute, Link, Outlet} from '@tanstack/solid-router'
import {TanStackRouterDevtools} from '@tanstack/solid-router-devtools'
import {createResource, Show} from 'solid-js'

import {authClient} from '../lib/auth-client'

export const Route = createRootRoute({
  component: () => {
    const [session] = createResource(() => {
      return authClient.getSession()
    })
    const [isAdmin] = createResource(async () => {
      const session = await authClient.getSession()
      console.log(session, session.data?.session?.user?.role)
      return session.data?.session?.user?.role === 'admin'
    })

    const handleSignOut = async () => {
      await authClient.signOut()
      window.location.href = '/'
    }

    return (
      <>
        <div class="p-2 flex justify-between">
          <div class="flex gap-2">
            <Show when={!session()?.data?.session}>
              <Link to="/" class="[&.active]:font-bold">
                Home
              </Link>{' '}
              <Link to="/about" class="[&.active]:font-bold">
                About
              </Link>
            </Show>
            <Show when={session()?.data?.session}>
              <Link to="/projects" class="[&.active]:font-bold">
                Projects
              </Link>
            </Show>
            <Show when={isAdmin()}>
              <Link to="/users" class="[&.active]:font-bold">
                Users
              </Link>
            </Show>
          </div>
          <div class="flex gap-2">
            <Show
              when={session()?.data?.session}
              fallback={
                <>
                  <Link to="/signup" class="[&.active]:font-bold">
                    Sign up
                  </Link>
                  <Link to="/signin" class="[&.active]:font-bold">
                    Sign in
                  </Link>
                </>
              }
            >
              <span class="text-gray-600">{session()?.data?.user?.email}</span>
              <button
                onClick={handleSignOut}
                class="text-red-600 hover:text-red-800"
              >
                Sign out
              </button>
            </Show>
          </div>
        </div>
        <hr />
        <Outlet />
        <TanStackRouterDevtools />
      </>
    )
  },
})
