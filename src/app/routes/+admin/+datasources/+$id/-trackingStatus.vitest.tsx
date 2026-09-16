// @vitest-environment happy-dom

import {QueryClient, QueryClientProvider} from '@tanstack/solid-query'
import type {ParentProps} from 'solid-js'
import {render} from 'solid-js/web'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'

import type {DataSourceTrackingState} from '../-trackingShared.ts'

type MockLinkProps = ParentProps<{class?: string; params?: {id?: string}; to: string}>

type MockDataSource = {
  covidencePackageConfig: null
  createdAt: string
  dateFrom: string | null
  dateTo: string | null
  description: string | null
  id: string
  immutable: boolean
  importRoute: string | null
  itemsAfterLastImport: number
  lastImportAt: string | null
  linkedProjectId: string | null
  linkedPromptIds: string[]
  reimportable: boolean
  structuredFileConfig: null
  title: string
  trackingEnabled: boolean
  trackingReconcileScheduleMonths: number[]
  trackingState: DataSourceTrackingState | null
  updatedAt: string
}

const mockState = vi.hoisted(() => {
  return {
    dataSource: null as MockDataSource | null,
    dataSourceId: 'source-1',
    getCalls: 0,
    patchPayloads: [] as unknown[],
    reconcileCalls: 0,
  }
})

const buildDataSource = (trackingState?: DataSourceTrackingState | null): MockDataSource => {
  return {
    covidencePackageConfig: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    dateFrom: '2026-01-01T00:00:00.000Z',
    dateTo: null,
    description: 'Tracks PubMed',
    id: 'source-1',
    immutable: false,
    importRoute: '/api/datasources/import/pubmed',
    itemsAfterLastImport: 0,
    lastImportAt: null,
    linkedProjectId: null,
    linkedPromptIds: [],
    reimportable: false,
    structuredFileConfig: null,
    title: 'Original title',
    trackingEnabled: true,
    trackingReconcileScheduleMonths: [3, 12, 24, 36],
    trackingState: trackingState ?? {
      granularity: 'day',
      highWaterCompletedAt: '2026-01-03T00:00:00.000Z',
      lastSuccessAt: '2026-01-03T00:00:00.000Z',
      nextRunAfter: '2026-01-04T00:00:00.000Z',
      pendingReconciliationCount: 1,
    },
    updatedAt: '2026-01-02T00:00:00.000Z',
  }
}

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
        return {
          ...options,
          useParams: () => {
            return () => {
              return {id: mockState.dataSourceId}
            }
          },
        }
      }
    },
    useNavigate: () => {
      return vi.fn()
    },
  }
})

vi.mock('../../../../../services/apiClient.ts', () => {
  const datasources = Object.assign(
    ({id}: {id: string}) => {
      return {
        delete: async () => {
          return {data: {success: true}}
        },
        get: async () => {
          mockState.getCalls += 1
          return {data: {data: {...mockState.dataSource, id}}}
        },
        patch: async (payload: unknown) => {
          mockState.patchPayloads.push(payload)
          mockState.dataSource = {...(mockState.dataSource ?? buildDataSource()), ...(payload as object)}
          return {data: {data: mockState.dataSource}}
        },
        tracking: {
          changes: {
            get: async () => {
              return {data: {data: {items: [], total: 0}}}
            },
          },
          reconcile: {
            post: async () => {
              mockState.reconcileCalls += 1
              mockState.dataSource = {
                ...(mockState.dataSource ?? buildDataSource()),
                trackingState: {
                  ...(mockState.dataSource?.trackingState ?? {}),
                  lastSuccessAt: '2026-01-05T00:00:00.000Z',
                  pendingReconciliationCount: 2,
                },
              }
              return {data: {success: true}}
            },
          },
        },
      }
    },
    {
      import: {
        covidence: {
          post: async () => {
            return {data: {success: true}}
          },
        },
      },
      post: async () => {
        return {data: {data: buildDataSource()}}
      },
    },
  )

  return {apiClient: {api: {datasources}}}
})

const waitForCondition = async (assertion: () => void, remaining = 30): Promise<void> => {
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

const getTextInputByValue = (container: HTMLElement, value: string) => {
  return Array.from(container.querySelectorAll<HTMLInputElement>('input[type="text"]')).find((input) => {
    return input.value === value
  })
}

const renderEditPage = async () => {
  const {AdminEditDataSource} = await import('./+edit.tsx')
  const queryClient = new QueryClient({defaultOptions: {mutations: {retry: false}, queries: {retry: false}}})
  const container = document.createElement('div')
  document.body.appendChild(container)
  const dispose = render(() => {
    return (
      <QueryClientProvider client={queryClient}>
        <AdminEditDataSource />
      </QueryClientProvider>
    )
  }, container)

  await waitForCondition(() => {
    expect(container.textContent).toContain('Tracking status')
  })

  return {container, dispose, queryClient}
}

beforeEach(() => {
  document.body.innerHTML = ''
  mockState.dataSourceId = 'source-1'
  mockState.dataSource = buildDataSource()
  mockState.getCalls = 0
  mockState.patchPayloads = []
  mockState.reconcileCalls = 0
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('data source edit tracking status', () => {
  test('runs full reconciliation and refreshes tracking status without overwriting unsaved form fields', async () => {
    const {container, dispose, queryClient} = await renderEditPage()

    try {
      const titleInput = getTextInputByValue(container, 'Original title')
      expect(titleInput).toBeInstanceOf(HTMLInputElement)

      if (titleInput) {
        titleInput.value = 'Unsaved local title'
        titleInput.dispatchEvent(new Event('input', {bubbles: true}))
      }

      const runButton = Array.from(container.querySelectorAll('button')).find((button) => {
        return button.textContent?.trim() === 'Run full reconciliation'
      })

      expect(runButton).toBeInstanceOf(HTMLButtonElement)
      runButton?.click()

      await waitForCondition(() => {
        expect(mockState.reconcileCalls).toBe(1)
        expect(mockState.getCalls).toBeGreaterThanOrEqual(2)
        expect(container.textContent).toContain('Full reconciliation queued.')
        expect(container.textContent).toContain('2')
      })

      expect(titleInput?.value).toBe('Unsaved local title')
    } finally {
      dispose()
      queryClient.clear()
      container.remove()
    }
  })
})
