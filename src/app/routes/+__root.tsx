import {createRootRoute, Outlet} from '@tanstack/solid-router'

import {Navigation} from '../../components/Navigation'
import {RouterErrorSurface} from '../routerErrorSurface'

const RootComponent = () => {
  return (
    <>
      <Navigation />
      <Outlet />
    </>
  )
}

export const Route = createRootRoute({component: RootComponent, errorComponent: RouterErrorSurface})
