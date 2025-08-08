import {createRouter, RouterProvider} from '@tanstack/solid-router'
import type {JSX} from 'solid-js'

import {routeTree} from '../routeTree.gen'

const router = createRouter({routeTree})

declare module '@tanstack/solid-router' {
  interface Register {
    router: typeof router
  }
}

export const Router = (): JSX.Element => {
  return <RouterProvider router={router} />
}
