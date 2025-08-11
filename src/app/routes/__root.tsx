import {createRootRoute, Link, Outlet} from '@tanstack/solid-router'
import {TanStackRouterDevtools} from '@tanstack/solid-router-devtools'
import {createEffect, onCleanup, Show} from 'solid-js'

import {startInfoUpdater, stopInfoUpdater} from '../../services/infoUpdater'
import {authStore} from '../../stores/authStore'

const RootComponent = () => {
  // Initialize auth on app mount
  createEffect(() => {
    void authStore.initialize()
  })

  // Initialize info updater
  createEffect(() => {
    startInfoUpdater()
  })

  // Cleanup auth subscription and info updater on unmount
  onCleanup(() => {
    authStore.cleanup()
    stopInfoUpdater()
  })

  return (
    <>
      <Show
        when={!authStore.isLoading()}
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
        <Show when={authStore.isAuthenticated()}>
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
              {/* Admin-only link - in a real app, check user role */}
              <Link
                to="/admin/users"
                class="text-sm text-primary hover:text-primary/80 font-medium"
              >
                Admin
              </Link>
              <Show when={authStore.user()}>
                <span class="text-sm text-muted-foreground">
                  {authStore.user()?.email}
                </span>
              </Show>
              <button
                onClick={() => {
                  void authStore.signOut()
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
