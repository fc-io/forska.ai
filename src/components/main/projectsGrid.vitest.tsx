// @vitest-environment happy-dom

import {QueryClient, QueryClientProvider} from '@tanstack/solid-query'
import type {ParentProps} from 'solid-js'
import {render} from 'solid-js/web'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'

import type {ProjectListItem} from '../../services/projectsService.ts'
import {ProjectsGrid} from './ProjectsGrid.tsx'
import {
  fetchProjectTransferExportSession,
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
                return mockApiState.getExportSession(exportId)
              },
            }
          },
        },
      },
    },
  }
})

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

beforeEach(() => {
  document.body.innerHTML = ''
  window.history.replaceState({}, '', 'http://localhost:3000/projects')
  mockApiState.getExportSession.mockReset()
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('ProjectsGrid export project link', () => {
  test('renders Export Project as a page link immediately after CSV Export data', async () => {
    const {container, dispose, queryClient} = await renderProjectsGrid()

    try {
      const labels = getActionLabels(container)
      const exportDataIndex = labels.indexOf('Export data')

      expect(container.querySelector('a[href="/projects/project-1/export"]')?.textContent?.trim()).toBe('Export data')
      expect(container.querySelector('a[href="/projects/project-1/export-project"]')?.textContent?.trim()).toBe(
        'Export Project',
      )
      expect(labels[exportDataIndex + 1]).toBe('Export Project')
      expect(container.querySelector('select[aria-label="Source import metadata mode"]')).toBeNull()
    } finally {
      dispose()
      queryClient.clear()
      container.remove()
    }
  })

  test('parses direct and nested export status success envelopes', async () => {
    mockApiState.getExportSession
      .mockResolvedValueOnce({
        data: {
          expiresAt: new Date('2030-01-01T00:00:00.000Z'),
          exportId: 'export-1',
          progress: {percent: 100},
          status: 'assembling',
        },
        error: null,
      })
      .mockResolvedValueOnce({data: {data: {...getReadyExportData(), expiresAt: new Date('2030-01-01T00:00:00.000Z')}}})
      .mockResolvedValueOnce({data: {data: {data: getReadyExportData(), error: null}, error: null}, error: null})

    const pendingSession = await fetchProjectTransferExportSession('export-1')
    const dataOnlyReadySession = await fetchProjectTransferExportSession('export-1')
    const nestedReadySession = await fetchProjectTransferExportSession('export-1')

    expect(pendingSession).toMatchObject({exportId: 'export-1', progress: {percent: 100}, status: 'assembling'})
    expect(pendingSession.expiresAt).toBe('2030-01-01T00:00:00.000Z')
    expect(dataOnlyReadySession).toMatchObject({
      exportId: 'export-1',
      filename: 'ready-project-transfer.zip',
      status: 'ready',
    })
    expect(nestedReadySession).toMatchObject({
      exportId: 'export-1',
      filename: 'ready-project-transfer.zip',
      status: 'ready',
    })
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
