import {createRootRoute, Outlet} from '@tanstack/solid-router'

import {Navigation} from '../../components/Navigation'

const RootComponent = () => {
  return (
    <>
      <Navigation />
      <Outlet />
    </>
  )
}

export const Route = createRootRoute({component: RootComponent})
