// @vitest-environment happy-dom

import {QueryClient, QueryClientProvider} from '@tanstack/solid-query'
import {render} from 'solid-js/web'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'

import type {ProjectListItem} from '../../../../services/projectsService.ts'
import {ArchivedProjectsTable} from './archivedProjectsTable.tsx'

const originalCreateObjectURL = Reflect.get(URL, 'createObjectURL')
const originalRevokeObjectURL = Reflect.get(URL, 'revokeObjectURL')
let anchorClickSpy: ReturnType<typeof vi.spyOn>

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

const getZipResponse = () => {
  return new Response('zip-body', {
    headers: {
      'content-disposition': 'attachment; filename="archived-project-transfer.zip"',
      'content-type': 'application/zip',
    },
  })
}

const waitForCondition = async (assertion: () => void, remaining = 30): Promise<void> => {
  try {
    assertion()
  } catch (error) {
    if (remaining <= 0) {
      throw error
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })
    return waitForCondition(assertion, remaining - 1)
  }
}

beforeEach(() => {
  document.body.innerHTML = ''
  window.history.replaceState({}, '', 'http://localhost:3000/projects/archived')
  vi.stubGlobal('fetch', vi.fn())
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => {
      return 'blob:project-transfer'
    }),
  })
  Object.defineProperty(URL, 'revokeObjectURL', {configurable: true, value: vi.fn()})
  anchorClickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Object.defineProperty(URL, 'createObjectURL', {configurable: true, value: originalCreateObjectURL})
  Object.defineProperty(URL, 'revokeObjectURL', {configurable: true, value: originalRevokeObjectURL})
})

describe('ArchivedProjectsTable export project action', () => {
  test('renders full-fidelity Export Project for archived rows without CSV Export data', async () => {
    const {container, dispose, queryClient} = await renderArchivedProjectsTable()

    try {
      expect(container.textContent).toContain('Export Project')
      expect(container.textContent).not.toContain('Export data')
    } finally {
      dispose()
      queryClient.clear()
      container.remove()
    }
  })

  test('starts an archived project transfer export from the row action', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValueOnce(getZipResponse())
    const {container, dispose, queryClient} = await renderArchivedProjectsTable()

    try {
      const exportProjectButton = Array.from(container.querySelectorAll('button')).find((button) => {
        return button.textContent?.trim() === 'Export Project'
      })

      exportProjectButton?.click()

      await waitForCondition(() => {
        expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:3001/api/projects/archived-project-1/export-project', {
          credentials: 'include',
          method: 'POST',
        })
        expect(anchorClickSpy).toHaveBeenCalled()
      })
    } finally {
      dispose()
      queryClient.clear()
      container.remove()
    }
  })
})
