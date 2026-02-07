import {createRouter, RouterProvider} from '@tanstack/solid-router'
import type {JSX} from 'solid-js'

import {routeTree} from './routeTree.gen'

const DefaultPending = (): JSX.Element => {
  return (
    <div class="p-6">
      <div class="flex items-center gap-3 text-gray-600">
        <svg class="h-5 w-5 animate-spin text-blue-600" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none" />
          <path
            class="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
          />
        </svg>
        <span>Loading...</span>
      </div>
    </div>
  )
}

const router = createRouter({routeTree, defaultPendingComponent: DefaultPending, defaultPendingMinMs: 200})

declare module '@tanstack/solid-router' {
  interface Register {
    router: typeof router
  }
}

export const Router = (): JSX.Element => {
  return <RouterProvider router={router} />
}
