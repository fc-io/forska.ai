import {createRootRoute, Link, Outlet} from '@tanstack/solid-router'
import {TanStackRouterDevtools} from '@tanstack/solid-router-devtools'

export const Route = createRootRoute({
  component: () => {
    return (
      <>
        <div class="p-2 flex justify-between">
          <div class="flex gap-2">
            <Link to="/" class="[&.active]:font-bold">
              Home
            </Link>{' '}
            <Link to="/about" class="[&.active]:font-bold">
              About
            </Link>
          </div>
          <div class="flex gap-2">
            <Link to="/signup" class="[&.active]:font-bold">
              Sign up
            </Link>
            <Link to="/signin" class="[&.active]:font-bold">
              Sign in
            </Link>
          </div>
        </div>
        <hr />
        <Outlet />
        <TanStackRouterDevtools />
      </>
    )
  },
})
