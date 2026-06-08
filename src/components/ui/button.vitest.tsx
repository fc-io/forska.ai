// @vitest-environment happy-dom

import {createMemoryHistory} from '@tanstack/history'
import {createRootRoute, createRoute, createRouter, Link, Outlet, RouterProvider} from '@tanstack/solid-router'
import {render} from 'solid-js/web'
import {afterEach, describe, expect, test, vi} from 'vitest'

import {Button} from './button'

const waitForUpdates = () => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

const renderRouterButtonLink = async () => {
  const rootRoute = createRootRoute({
    component: () => {
      return <Outlet />
    },
  })
  const indexRoute = createRoute({
    component: () => {
      return (
        <Button as={Link} to="/target">
          Target
        </Button>
      )
    },
    getParentRoute: () => {
      return rootRoute
    },
    path: '/',
  })
  const targetRoute = createRoute({
    component: () => {
      return <div>Target route</div>
    },
    getParentRoute: () => {
      return rootRoute
    },
    path: '/target',
  })
  const router = createRouter({
    defaultPreload: 'intent',
    history: createMemoryHistory({initialEntries: ['/']}),
    routeTree: rootRoute.addChildren([indexRoute, targetRoute]),
  })

  await router.load()

  const container = document.createElement('div')
  document.body.appendChild(container)
  const dispose = render(() => {
    return <RouterProvider router={router} />
  }, container)

  await waitForUpdates()

  return {container, dispose}
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('Button', () => {
  test('does not create Solid computations outside a root when router links are hovered', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const {container, dispose} = await renderRouterButtonLink()

    try {
      container.querySelector('a')?.dispatchEvent(new MouseEvent('mouseover', {bubbles: true}))

      const warnings = warnSpy.mock.calls.flat().join('\n')

      expect(warnings).not.toContain('computations created outside')
    } finally {
      dispose()
      container.remove()
    }
  })
})
