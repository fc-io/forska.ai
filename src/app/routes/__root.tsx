import {createRootRoute, Link, Outlet} from '@tanstack/solid-router'
import {TanStackRouterDevtools} from '@tanstack/solid-router-devtools'

export const Route = createRootRoute({
  component: () => {
    return (
      <>
        <div class="p-2 flex gap-2">
          <Link to="/" class="[&.active]:font-bold">
            Home
          </Link>{' '}
          <Link to="/about" class="[&.active]:font-bold">
            About
          </Link>
          <Link to="/signup" class="[&.active]:font-bold">
            Sign up
          </Link>
        </div>
        <hr />
        <Outlet />
        <TanStackRouterDevtools />
      </>
    )
  },
})
