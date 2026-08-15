// @vitest-environment happy-dom

import type {Component} from 'solid-js'
import {render} from 'solid-js/web'
import {afterEach, beforeEach, expect, test, vi} from 'vitest'

type BackendAvailabilityQueryResult = {
  data: {ready: boolean} | undefined
  error: Error | null
  isError: boolean
  isRefetching: boolean
  refetch: ReturnType<typeof vi.fn>
}

const mockState = vi.hoisted(() => {
  return {queryResult: null as BackendAvailabilityQueryResult | null, rootComponent: null as Component | null}
})

vi.mock('@tanstack/solid-query', () => {
  return {
    useQuery: () => {
      return mockState.queryResult
    },
  }
})

vi.mock('@tanstack/solid-router', () => {
  return {
    createRootRoute: (options: {component: Component}) => {
      mockState.rootComponent = options.component
      return {options}
    },
    Outlet: () => {
      return <main>Project route outlet</main>
    },
  }
})

vi.mock('../../components/Navigation', () => {
  return {
    Navigation: () => {
      return null
    },
  }
})

vi.mock('../../services/apiClient.ts', () => {
  return {apiClient: {}}
})

vi.mock('../routerErrorSurface', () => {
  return {
    RouterErrorSurface: () => {
      return null
    },
  }
})

vi.mock('../utils/client-env.ts', () => {
  return {env: {VITE_SERVER_API: 'http://localhost:3001'}}
})

await import('./+__root.tsx')

const mountedRoots: Array<() => void> = []

const renderRoot = () => {
  const container = document.createElement('div')
  const RootComponent = mockState.rootComponent

  if (RootComponent === null) {
    throw new Error('Root component was not registered')
  }

  document.body.append(container)
  mountedRoots.push(() => {
    container.remove()
  })
  mountedRoots.push(
    render(() => {
      return <RootComponent />
    }, container),
  )

  return container
}

beforeEach(() => {
  mockState.queryResult = {
    data: undefined,
    error: new Error('Initial backend readiness failed'),
    isError: true,
    isRefetching: false,
    refetch: vi.fn(),
  }
})

afterEach(() => {
  mountedRoots
    .splice(0)
    .reverse()
    .map((cleanup) => {
      cleanup()
    })
})

test('shows the full-page unavailable surface when initial readiness fails without cached data', () => {
  const container = renderRoot()

  expect(container.textContent).toContain('Backend unavailable')
  expect(container.textContent).not.toContain('Project route outlet')
})

test('keeps the existing route outlet mounted when a readiness refetch fails after success', () => {
  mockState.queryResult = {
    data: {ready: true},
    error: new Error('Background readiness refetch failed'),
    isError: true,
    isRefetching: false,
    refetch: vi.fn(),
  }
  const container = renderRoot()

  expect(container.textContent).toContain('Project route outlet')
  expect(container.textContent).not.toContain('Backend unavailable')
})
