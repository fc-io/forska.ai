// @vitest-environment happy-dom

import {QueryClient, QueryClientProvider} from '@tanstack/solid-query'
import type {ParentProps} from 'solid-js'
import {render} from 'solid-js/web'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'

import {
  type DataSourceImportStatusView,
  getDataSourcesRefetchInterval,
  getImportEtaLabel,
  getImportProgressLabel,
} from './-importStatus.ts'

type MockLinkProps = ParentProps<{class?: string; params?: {id?: string}; to: string}>

const mockState = vi.hoisted(() => {
  return {entries: [] as Array<Record<string, unknown>>, getCalls: 0, pubmedPosts: [] as string[]}
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
    createFileRoute: () => {
      return (options: Record<string, unknown>) => {
        return options
      }
    },
  }
})

vi.mock('../../../../services/apiClient.ts', () => {
  const datasources = Object.assign(
    () => {
      return {
        delete: async () => {
          return {data: {success: true}}
        },
      }
    },
    {
      get: async () => {
        mockState.getCalls += 1
        return {data: {data: mockState.entries}}
      },
      import: {
        pubmed: {
          post: async ({id}: {id: string}) => {
            mockState.pubmedPosts.push(id)
            return {data: {success: true}}
          },
        },
      },
    },
  )

  return {apiClient: {api: {datasources}}}
})

const runningStatus: DataSourceImportStatusView = {
  completedAt: null,
  consecutiveFailureCount: 0,
  failedAt: null,
  fetchedCount: 120_000,
  lastError: null,
  lastProgressAt: '2026-09-26T11:00:00.000Z',
  nextRetryAt: null,
  progressFromStart: true,
  runStartedAt: '2026-09-26T10:00:00.000Z',
  runStartFetchedCount: 60_000,
  status: 'running',
  storedCount: 119_990,
  totalCount: 588_062,
}

const buildEntry = (id: string, title: string, importStatus: DataSourceImportStatusView | null) => {
  return {
    covidencePackageConfig: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    dateFrom: '2026-05-01T00:00:00.000Z',
    dateTo: '2026-09-01T00:00:00.000Z',
    description: null,
    id,
    immutable: false,
    importRoute: '/api/datasources/import/pubmed',
    importStatus,
    itemsAfterLastImport: 0,
    lastImportAt: null,
    linkedProjectId: null,
    linkedPromptIds: [],
    reimportable: false,
    structuredFileConfig: null,
    title,
    updatedAt: '2026-09-26T10:00:00.000Z',
  }
}

const failedStatus: DataSourceImportStatusView = {
  ...runningStatus,
  consecutiveFailureCount: 5,
  failedAt: '2026-09-26T11:30:00.000Z',
  lastError: 'DuckDB workload budget exceeded for import.storeArticles',
  status: 'failed',
}

const interruptedStatus: DataSourceImportStatusView = {
  ...runningStatus,
  fetchedCount: 0,
  lastProgressAt: null,
  progressFromStart: false,
  runStartedAt: null,
  runStartFetchedCount: 0,
  status: 'interrupted',
  storedCount: 0,
  totalCount: null,
}

const completedStatus: DataSourceImportStatusView = {
  ...runningStatus,
  completedAt: '2026-09-26T12:00:00.000Z',
  status: 'completed',
}

const waitForCondition = async (assertion: () => void, remaining = 50): Promise<void> => {
  try {
    assertion()
  } catch (error) {
    if (remaining <= 0) {
      throw error
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
    return waitForCondition(assertion, remaining - 1)
  }
}

const getRow = (container: HTMLElement, title: string) => {
  return Array.from(container.querySelectorAll('tbody tr')).find((row) => {
    return row.textContent?.includes(title)
  })
}

const getRowButtonLabels = (container: HTMLElement, title: string) => {
  return Array.from(getRow(container, title)?.querySelectorAll('button') ?? []).map((button) => {
    return button.textContent?.trim()
  })
}

const renderListPage = async () => {
  const {AdminDataSources} = await import('./+index.tsx')
  const queryClient = new QueryClient({defaultOptions: {mutations: {retry: false}, queries: {retry: false}}})
  const container = document.createElement('div')
  document.body.appendChild(container)
  const dispose = render(() => {
    return (
      <QueryClientProvider client={queryClient}>
        <AdminDataSources />
      </QueryClientProvider>
    )
  }, container)

  await waitForCondition(() => {
    expect(container.querySelectorAll('tbody tr').length).toBe(mockState.entries.length)
  })

  return {
    cleanup: () => {
      dispose()
      queryClient.clear()
    },
    container,
  }
}

beforeEach(() => {
  document.body.innerHTML = ''
  mockState.entries = []
  mockState.getCalls = 0
  mockState.pubmedPosts = []
  vi.stubGlobal('alert', vi.fn())
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('data source import status helpers', () => {
  test('progress shows stored of total with the share fetched and an ETA from the rate since the run started', () => {
    expect(getImportProgressLabel(runningStatus)).toBe('Stored 119,990 of 588,062 (20.4%)')
    expect(getImportEtaLabel(runningStatus)).toBe('about 7 h 48 min left at the current rate')
  })

  test('progress without a provider total or without earlier counts has no percentage or ETA', () => {
    expect(getImportProgressLabel({...runningStatus, totalCount: null})).toBe('Stored 119,990')
    expect(getImportEtaLabel({...runningStatus, totalCount: null})).toBeNull()
    expect(getImportProgressLabel({...runningStatus, progressFromStart: false})).toBe(
      'Stored 119,990 since the import was resumed (earlier progress was not recorded)',
    )
    expect(getImportEtaLabel({...runningStatus, progressFromStart: false})).toBeNull()
    expect(getImportEtaLabel({...runningStatus, lastProgressAt: null})).toBeNull()
  })

  test('the list polls only while an import is running', () => {
    expect(getDataSourcesRefetchInterval([{importStatus: runningStatus}, {importStatus: null}])).toBe(15_000)
    expect(
      getDataSourcesRefetchInterval([
        {importStatus: failedStatus},
        {importStatus: interruptedStatus},
        {importStatus: completedStatus},
        {importStatus: null},
      ]),
    ).toBe(false)
    expect(getDataSourcesRefetchInterval(undefined)).toBe(false)
  })
})

describe('data sources list import status', () => {
  test('shows running progress, a failed import with its error, an interrupted import and a completed one', async () => {
    mockState.entries = [
      buildEntry('source-running', 'Running source', runningStatus),
      buildEntry('source-failed', 'Failed source', failedStatus),
      buildEntry('source-interrupted', 'Interrupted source', interruptedStatus),
      buildEntry('source-completed', 'Completed source', completedStatus),
      buildEntry('source-new', 'New source', null),
    ]
    const {cleanup, container} = await renderListPage()

    try {
      const runningText = getRow(container, 'Running source')?.textContent ?? ''
      const failedText = getRow(container, 'Failed source')?.textContent ?? ''
      const interruptedText = getRow(container, 'Interrupted source')?.textContent ?? ''
      const completedText = getRow(container, 'Completed source')?.textContent ?? ''
      const newText = getRow(container, 'New source')?.textContent ?? ''

      expect(runningText).toContain('Import: Running')
      expect(runningText).toContain('Stored 119,990 of 588,062 (20.4%)')
      expect(runningText).toContain('Last page ')
      expect(runningText).toContain('about 7 h 48 min left at the current rate')
      expect(failedText).toContain('Import: Failed')
      expect(failedText).toContain('DuckDB workload budget exceeded for import.storeArticles')
      expect(failedText).toContain('Automatic retries stopped. Resume continues from the saved cursor.')
      expect(interruptedText).toContain('Import: Interrupted')
      expect(interruptedText).toContain('Resume continues from the saved cursor.')
      expect(completedText).toContain('Import: Completed')
      expect(newText).not.toMatch(/Import: (Running|Failed|Interrupted|Completed)/)
      expect(getRowButtonLabels(container, 'Running source')).toContain('New Import')
      expect(getRowButtonLabels(container, 'Failed source')).toContain('Resume')
      expect(getRowButtonLabels(container, 'Interrupted source')).toContain('Resume')
      expect(getRowButtonLabels(container, 'Completed source')).toContain('New Import')
      expect(getRowButtonLabels(container, 'New source')).toContain('New Import')
    } finally {
      cleanup()
    }
  })

  test('Resume on an interrupted import starts the same import request as New Import', async () => {
    mockState.entries = [buildEntry('source-interrupted', 'Interrupted source', interruptedStatus)]
    const {cleanup, container} = await renderListPage()

    try {
      const resumeButton = Array.from(getRow(container, 'Interrupted source')?.querySelectorAll('button') ?? []).find(
        (button) => {
          return button.textContent?.trim() === 'Resume'
        },
      )

      resumeButton?.click()
      await waitForCondition(() => {
        expect(mockState.pubmedPosts).toEqual(['source-interrupted'])
      })
    } finally {
      cleanup()
    }
  })

  test('refetches the list while an import runs and stops polling when none is running', async () => {
    vi.useFakeTimers({shouldAdvanceTime: true})
    mockState.entries = [buildEntry('source-running', 'Running source', runningStatus)]
    const {cleanup} = await renderListPage()

    try {
      const callsAfterLoad = mockState.getCalls

      await vi.advanceTimersByTimeAsync(15_500)
      await waitForCondition(() => {
        expect(mockState.getCalls).toBe(callsAfterLoad + 1)
      })

      mockState.entries = [buildEntry('source-running', 'Running source', completedStatus)]
      await vi.advanceTimersByTimeAsync(15_500)
      await waitForCondition(() => {
        expect(mockState.getCalls).toBe(callsAfterLoad + 2)
      })

      await vi.advanceTimersByTimeAsync(60_000)
      expect(mockState.getCalls).toBe(callsAfterLoad + 2)
    } finally {
      cleanup()
    }
  })
})
