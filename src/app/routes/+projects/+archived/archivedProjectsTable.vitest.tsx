// @vitest-environment happy-dom

import {QueryClient, QueryClientProvider} from '@tanstack/solid-query'
import type {ParentProps} from 'solid-js'
import {render} from 'solid-js/web'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'

import type {ProjectListItem} from '../../../../services/projectsService.ts'
import {ArchivedProjectsTable} from './archivedProjectsTable.tsx'

type MockLinkProps = ParentProps<{class?: string; params?: {id?: string}; to: string}>

vi.mock('@tanstack/solid-router', () => {
  return {
    Link: (props: MockLinkProps) => {
      return (
        <a class={props.class} href={props.params?.id ? props.to.replace('$id', props.params.id) : props.to}>
          {props.children}
        </a>
      )
    },
  }
})

const getArchivedProject = (overrides: Partial<ProjectListItem> = {}): ProjectListItem => {
  return {
    archived: true,
    createdAt: new Date('2026-05-24T10:00:00.000Z'),
    dateFrom: null,
    dateTo: null,
    description: 'Archived project description',
    humanJudgmentMode: 'prompt',
    id: 'archived-project-1',
    modelId: 'model-1',
    modelName: 'Review model',
    modelProvider: 'openai',
    modelVersion: null,
    name: 'Archived project',
    updatedAt: new Date('2026-05-24T10:00:00.000Z'),
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useMetadata: false,
    useTitle: true,
    ...overrides,
  }
}

const getQueryClient = () => {
  return new QueryClient({defaultOptions: {mutations: {retry: false}, queries: {retry: false}}})
}

const renderArchivedProjectsTable = async (projects: ProjectListItem[] = [getArchivedProject()]) => {
  const queryClient = getQueryClient()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const dispose = render(() => {
    return (
      <QueryClientProvider client={queryClient}>
        <ArchivedProjectsTable projects={projects} />
      </QueryClientProvider>
    )
  }, container)

  await Promise.resolve()

  return {container, dispose, queryClient}
}

beforeEach(() => {
  document.body.innerHTML = ''
  window.history.replaceState({}, '', 'http://localhost:3000/projects/archived')
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('ArchivedProjectsTable export project action', () => {
  test('renders full-fidelity Export Project as a page link for archived rows without CSV Export data', async () => {
    const {container, dispose, queryClient} = await renderArchivedProjectsTable()

    try {
      expect(container.textContent).toContain('Export Project')
      expect(container.textContent).not.toContain('Export data')
      expect(
        container.querySelector('a[href="/projects/archived-project-1/export-project"]')?.textContent?.trim(),
      ).toBe('Export Project')
    } finally {
      dispose()
      queryClient.clear()
      container.remove()
    }
  })
})

describe('ArchivedProjectsTable row selection', () => {
  test('row checkboxes select and deselect archived projects', async () => {
    const {container, dispose, queryClient} = await renderArchivedProjectsTable([
      getArchivedProject({id: 'archived-project-1', name: 'First archived project'}),
      getArchivedProject({id: 'archived-project-2', name: 'Second archived project'}),
    ])

    try {
      const checkboxes = [...container.querySelectorAll<HTMLInputElement>('tbody input[type="checkbox"]')]

      checkboxes[0]?.click()
      checkboxes[1]?.click()
      expect(container.textContent).toContain('2 selected on this page')
      expect(
        checkboxes.map((checkbox) => {
          return checkbox.checked
        }),
      ).toEqual([true, true])

      checkboxes[0]?.click()
      expect(container.textContent).toContain('1 selected on this page')
      expect(
        checkboxes.map((checkbox) => {
          return checkbox.checked
        }),
      ).toEqual([false, true])
    } finally {
      dispose()
      queryClient.clear()
      container.remove()
    }
  })
})
