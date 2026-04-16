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
  return {queryResult: {data: [{id: 'project-1'}], error: null, isError: false, isLoading: false}}
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
    mockState.queryResult = {data: [{id: 'project-1'}], error: null, isError: false, isLoading: false}
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
        {href: '/admin/datasources/covidence-import', label: 'Create Covidence Project'},
        {href: '/projects/create', label: 'Create New Project'},
      ])
      expect(container.querySelector('[data-testid="projects-grid"]')?.textContent).toBe('1')
    } finally {
      dispose()
      container.remove()
    }
  })
})
