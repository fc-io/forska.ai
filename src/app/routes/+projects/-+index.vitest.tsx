// @vitest-environment happy-dom

import type {Component, JSX, ParentProps} from 'solid-js'
import {splitProps} from 'solid-js'
import {Dynamic} from 'solid-js/web'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'

type MockLinkProps = ParentProps<{class?: string; to: string}>
type MockButtonProps = ParentProps<
  {as?: keyof JSX.IntrinsicElements | Component<Record<string, unknown>>} & Record<string, unknown>
>

const mockState = vi.hoisted(() => {
  return {
    modelsQueryResult: {data: [{id: 'model-1'}], error: null, isError: false, isLoading: false},
    projectsQueryResult: {data: [{id: 'project-1'}], error: null, isError: false, isLoading: false},
    providerConnectionsQueryResult: {
      data: {catalog: [], connections: [{id: 'provider-1', models: [{id: 'model-1'}]}], runtime: null},
      error: null,
      isError: false,
      isLoading: false,
    },
  }
})

vi.mock('@tanstack/solid-query', () => {
  return {
    useQuery: (options: () => {queryKey: unknown[]}) => {
      const queryKey = options().queryKey
      const rootKey = queryKey[0]

      if (rootKey === 'provider-connections') {
        return mockState.providerConnectionsQueryResult
      }
      if (rootKey === 'models') {
        return mockState.modelsQueryResult
      }
      return mockState.projectsQueryResult
    },
  }
})

vi.mock('@tanstack/solid-router', () => {
  return {
    Link: (props: MockLinkProps) => {
      return (
        <a class={props.class} href={props.to}>
          {props.children}
        </a>
      )
    },
    createFileRoute: () => {
      return () => {
        return {}
      }
    },
  }
})

vi.mock('../../../components/main/ProjectsGrid', () => {
  return {
    ProjectsGrid: (props: {projects: unknown[]}) => {
      return <div data-testid="projects-grid">{props.projects.length}</div>
    },
  }
})

vi.mock('../../../components/ui/button', () => {
  return {
    Button: (props: MockButtonProps) => {
      const [local, otherProps] = splitProps(props, ['as', 'children'])

      return (
        <Dynamic component={local.as ?? 'button'} {...otherProps}>
          {local.children}
        </Dynamic>
      )
    },
  }
})

const renderProjectsPage = async () => {
  const {render} = await import('solid-js/web')
  const {ProjectsPage} = await import('./+index.tsx')

  const container = document.createElement('div')
  document.body.appendChild(container)
  const dispose = render(() => {
    return <ProjectsPage />
  }, container)

  await Promise.resolve()

  return {container, dispose}
}

describe('projects index route', () => {
  beforeEach(() => {
    vi.resetModules()
    document.body.innerHTML = ''
    mockState.modelsQueryResult = {data: [{id: 'model-1'}], error: null, isError: false, isLoading: false}
    mockState.projectsQueryResult = {data: [{id: 'project-1'}], error: null, isError: false, isLoading: false}
    mockState.providerConnectionsQueryResult = {
      data: {catalog: [], connections: [{id: 'provider-1', models: [{id: 'model-1'}]}], runtime: null},
      error: null,
      isError: false,
      isLoading: false,
    }
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  test('renders project header actions in the expected order', async () => {
    const {container, dispose} = await renderProjectsPage()

    try {
      const links = Array.from(container.querySelectorAll('a')).map((link) => {
        return {href: link.getAttribute('href'), label: link.textContent?.trim() ?? ''}
      })

      expect(links).toEqual([
        {href: '/projects/archived', label: 'Show Archived'},
        {href: '/projects/create-subproject', label: 'Create Subproject'},
        {href: '/projects/import', label: 'Import Project'},
        {href: '/admin/datasources/covidence-import', label: 'Create Covidence Project'},
        {href: '/projects/create', label: 'Create New Project'},
      ])
      expect(
        links.findIndex((link) => {
          return link.label === 'Import Project'
        }),
      ).toBe(
        links.findIndex((link) => {
          return link.label === 'Create Covidence Project'
        }) - 1,
      )
      expect(container.querySelector('[data-testid="projects-grid"]')?.textContent).toBe('1')
    } finally {
      dispose()
      container.remove()
    }
  })

  test('shows provider setup guidance when providers are missing', async () => {
    mockState.projectsQueryResult = {data: [], error: null, isError: false, isLoading: false}
    mockState.providerConnectionsQueryResult = {
      data: {catalog: [], connections: [], runtime: null},
      error: null,
      isError: false,
      isLoading: false,
    }
    mockState.modelsQueryResult = {data: [], error: null, isError: false, isLoading: false}

    const {container, dispose} = await renderProjectsPage()

    try {
      expect(container.textContent).toContain('No providers configured')
      expect(container.textContent).toContain('Add a provider and enable at least one model before creating a project.')
      expect(container.querySelector('a[href="/providers/add-provider"]')?.textContent?.trim()).toBe('Add Provider')
      expect(container.textContent).toContain('No projects found')
    } finally {
      dispose()
      container.remove()
    }
  })

  test('shows model setup guidance when selectable models are missing', async () => {
    mockState.projectsQueryResult = {data: [], error: null, isError: false, isLoading: false}
    mockState.providerConnectionsQueryResult = {
      data: {catalog: [], connections: [{id: 'provider-1', models: []}], runtime: null},
      error: null,
      isError: false,
      isLoading: false,
    }
    mockState.modelsQueryResult = {data: [], error: null, isError: false, isLoading: false}

    const {container, dispose} = await renderProjectsPage()

    try {
      expect(container.textContent).toContain('No models available')
      expect(container.textContent).toContain('Open Providers to sync or add a model for an enabled provider.')
      expect(container.querySelector('a[href="/providers"]')?.textContent?.trim()).toBe('Manage Providers')
    } finally {
      dispose()
      container.remove()
    }
  })
})
