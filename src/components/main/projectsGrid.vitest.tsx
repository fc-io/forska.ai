// @vitest-environment happy-dom

import {QueryClient, QueryClientProvider} from '@tanstack/solid-query'
import type {ParentProps} from 'solid-js'
import {render} from 'solid-js/web'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'

import type {ProjectListItem} from '../../services/projectsService.ts'
import {ProjectsGrid} from './ProjectsGrid.tsx'
import {
  getProjectTransferDownloadRequestUrl,
  getProjectTransferExportRequestUrl,
} from './projectsGrid/projectTransferExportAction.tsx'

type MockLinkProps = ParentProps<{class?: string; params?: {id?: string}; to: string}>
type ReadyExportData = {
  byteLength: number
  checksumSha256: string
  downloadUrl: string
  expiresAt: string
  exportId: string
  filename: string
  packageFingerprint: string
  progress: {percent: number}
  status: 'ready'
}

const mockApiState = vi.hoisted(() => {
  return {getExportSession: vi.fn<(exportId: string) => Promise<unknown>>()}
})

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

vi.mock('../../app/routes/+admin/+models/providerConnectionsClient.ts', () => {
  return {
    fetchProviderConnections: async () => {
      return {catalog: [], connections: [], runtime: null}
    },
  }
})

vi.mock('../../services/apiClient.ts', () => {
  return {
    apiClient: {
      api: {
        projects: {
          export: ({exportId}: {exportId: string}) => {
            return {
              get: () => {
                const response = mockApiState.getExportSession(exportId)

                return response
              },
            }
          },
        },
      },
    },
  }
})

const originalCreateObjectURL = Reflect.get(URL, 'createObjectURL')
const originalRevokeObjectURL = Reflect.get(URL, 'revokeObjectURL')
let anchorClickSpy: ReturnType<typeof vi.spyOn>

const getProject = (overrides: Partial<ProjectListItem> = {}): ProjectListItem => {
  return {
    archived: false,
    createdAt: new Date('2026-05-24T10:00:00.000Z'),
    dateFrom: null,
    dateTo: null,
    description: 'Project description',
    humanJudgmentMode: 'prompt',
    id: 'project-1',
    modelId: 'model-1',
    modelName: 'Review model',
    modelProvider: 'openai',
    modelVersion: null,
    name: 'Active project',
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

const renderProjectsGrid = async (projects: ProjectListItem[] = [getProject()]) => {
  const queryClient = getQueryClient()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const dispose = render(() => {
    return (
      <QueryClientProvider client={queryClient}>
        <ProjectsGrid projects={projects} />
      </QueryClientProvider>
    )
  }, container)

  await Promise.resolve()

  return {container, dispose, queryClient}
}

const getActionLabels = (container: HTMLElement) => {
  return Array.from(container.querySelectorAll('a, button')).map((element) => {
    return element.textContent?.trim() ?? ''
  })
}

const tick = () => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

const waitForCondition = async (assertion: () => void, remaining = 30): Promise<void> => {
  try {
    assertion()
  } catch (error) {
    if (remaining <= 0) {
      throw error
    }

    await tick()
    return waitForCondition(assertion, remaining - 1)
  }
}

const getReadyExportData = (overrides: Partial<ReadyExportData> = {}): ReadyExportData => {
  return {
    byteLength: 8,
    checksumSha256: 'a'.repeat(64),
    downloadUrl: '/api/projects/export/export-1/download',
    expiresAt: '2030-01-01T00:00:00.000Z',
    exportId: 'export-1',
    filename: 'ready-project-transfer.zip',
    packageFingerprint: 'fingerprint-1',
    progress: {percent: 100},
    status: 'ready',
    ...overrides,
  }
}

const getQueuedExportResponse = () => {
  return new Response(
    JSON.stringify({
      data: {
        downloadUrl: '/api/projects/export/export-1/download',
        expiresAt: '2030-01-01T00:00:00.000Z',
        exportId: 'export-1',
        filename: 'queued-project-transfer.zip',
        status: 'queued',
      },
      error: null,
    }),
    {headers: {'content-type': 'application/json'}, status: 202},
  )
}

const getZipResponse = (filename: string) => {
  return new Response('zip-body', {
    headers: {'content-disposition': `attachment; filename="${filename}"`, 'content-type': 'application/zip'},
  })
}

const createDeferred = <T,>() => {
  let resolve = (_value: T) => {}
  const promise = new Promise<T>((resolveValue) => {
    resolve = resolveValue
  })

  return {promise, resolve}
}

beforeEach(() => {
  document.body.innerHTML = ''
  window.history.replaceState({}, '', 'http://localhost:3000/projects')
  mockApiState.getExportSession.mockReset()
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

describe('ProjectsGrid export project action', () => {
  test('renders Export Project immediately after the existing CSV Export data action', async () => {
    const {container, dispose, queryClient} = await renderProjectsGrid()

    try {
      const labels = getActionLabels(container)
      const exportDataIndex = labels.indexOf('Export data')

      expect(container.querySelector('a[href="/projects/project-1/export"]')?.textContent?.trim()).toBe('Export data')
      expect(labels[exportDataIndex + 1]).toBe('Export Project')
    } finally {
      dispose()
      queryClient.clear()
      container.remove()
    }
  })

  test('downloads an inline full-fidelity export without changing the CSV export link', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValueOnce(getZipResponse('project-transfer-project-1.zip'))
    const {container, dispose, queryClient} = await renderProjectsGrid()

    try {
      const exportProjectButton = Array.from(container.querySelectorAll('button')).find((button) => {
        return button.textContent?.trim() === 'Export Project'
      })

      exportProjectButton?.click()

      await waitForCondition(() => {
        expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:3001/api/projects/project-1/export-project', {
          credentials: 'include',
          method: 'POST',
        })
        expect(anchorClickSpy).toHaveBeenCalled()
        expect(container.querySelector('a[href="/projects/project-1/export"]')?.textContent?.trim()).toBe('Export data')
      })
    } finally {
      dispose()
      queryClient.clear()
      container.remove()
    }
  })

  test('shows preparing state for queued exports, polls JSON metadata, and downloads the ready package', async () => {
    const fetchMock = vi.mocked(fetch)
    const readyDeferred = createDeferred<{data: {data: ReadyExportData; error: null}; error: null}>()
    fetchMock.mockResolvedValueOnce(getQueuedExportResponse())
    fetchMock.mockResolvedValueOnce(getZipResponse('ready-project-transfer.zip'))
    mockApiState.getExportSession.mockReturnValue(readyDeferred.promise)
    const {container, dispose, queryClient} = await renderProjectsGrid()

    try {
      const exportProjectButton = Array.from(container.querySelectorAll('button')).find((button) => {
        return button.textContent?.trim() === 'Export Project'
      })

      exportProjectButton?.click()

      await waitForCondition(() => {
        expect(container.textContent).toContain('Preparing download...')
        expect(mockApiState.getExportSession).toHaveBeenCalledWith('export-1')
      })

      readyDeferred.resolve({data: {data: getReadyExportData(), error: null}, error: null})

      await waitForCondition(() => {
        expect(fetchMock).toHaveBeenLastCalledWith('http://127.0.0.1:3001/api/projects/export/export-1/download', {
          credentials: 'include',
          method: 'GET',
        })
        expect(anchorClickSpy).toHaveBeenCalled()
      })
    } finally {
      dispose()
      queryClient.clear()
      container.remove()
    }
  })

  test('does not immediately retry a failed ready-session download', async () => {
    const fetchMock = vi.mocked(fetch)
    const readyDeferred = createDeferred<{data: {data: ReadyExportData; error: null}; error: null}>()
    fetchMock.mockResolvedValueOnce(getQueuedExportResponse())
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({data: null, error: 'Project transfer export package artifact is unavailable'}), {
        headers: {'content-type': 'application/json'},
        status: 410,
      }),
    )
    mockApiState.getExportSession.mockReturnValue(readyDeferred.promise)
    const {container, dispose, queryClient} = await renderProjectsGrid()

    try {
      const exportProjectButton = Array.from(container.querySelectorAll('button')).find((button) => {
        return button.textContent?.trim() === 'Export Project'
      })

      exportProjectButton?.click()

      await waitForCondition(() => {
        expect(mockApiState.getExportSession).toHaveBeenCalledWith('export-1')
      })

      readyDeferred.resolve({data: {data: getReadyExportData(), error: null}, error: null})

      await waitForCondition(() => {
        expect(container.textContent).toContain('Project transfer export package artifact is unavailable')
      })
      await tick()

      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      dispose()
      queryClient.clear()
      container.remove()
    }
  })

  test('resolves export and download paths for browser and desktop runtimes', () => {
    expect(getProjectTransferExportRequestUrl('project 1', 'views://mainview', 'http://127.0.0.1:32101')).toBe(
      'http://127.0.0.1:32101/api/projects/project%201/export-project',
    )
    expect(
      getProjectTransferDownloadRequestUrl('/api/projects/export/export-1/download', 'http://localhost:3000'),
    ).toBe('http://127.0.0.1:3001/api/projects/export/export-1/download')
  })
})
