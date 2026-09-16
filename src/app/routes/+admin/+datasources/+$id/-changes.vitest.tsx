// @vitest-environment happy-dom

import {QueryClient, QueryClientProvider} from '@tanstack/solid-query'
import type {ParentProps} from 'solid-js'
import {render} from 'solid-js/web'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'

type MockLinkProps = ParentProps<{class?: string; params?: {id?: string}; to: string}>

const mockState = vi.hoisted(() => {
  return {
    changesQueries: [] as Array<Record<string, number | string>>,
    dataSourceId: 'source-1',
    items: [
      {
        articleId: 'article-1',
        changeKind: 'source_record_deleted',
        detectedAt: '2026-02-01T12:00:00.000Z',
        externalArticleId: 'PMID:1',
        id: 'change-1',
        nextSourceRecordHash: null,
        previousSourceRecordHash: 'hash-before',
        runKind: 'manual_full_range',
        sourceRecordKey: 'pmid:1',
      },
      {
        articleId: null,
        changeKind: 'source_record_changed',
        detectedAt: '2026-02-01T11:00:00.000Z',
        externalArticleId: 'PMID:2',
        id: 'change-2',
        nextSourceRecordHash: 'hash-next',
        previousSourceRecordHash: 'hash-prev',
        runKind: 'incremental',
        sourceRecordKey: 'pmid:2',
      },
    ],
    nextCursor: null as string | null,
  }
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
  }
})

vi.mock('../../../../../services/apiClient.ts', () => {
  return {
    apiClient: {
      api: {
        datasources: ({id}: {id: string}) => {
          return {
            get: async () => {
              return {data: {data: {id}}}
            },
            tracking: {
              changes: {
                get: async ({query}: {query: Record<string, number | string>}) => {
                  mockState.changesQueries.push(query)
                  return {
                    data: {
                      data: {
                        hasMore: mockState.nextCursor !== null,
                        items: mockState.items,
                        limit: 50,
                        nextCursor: mockState.nextCursor,
                      },
                    },
                  }
                },
              },
              reconcile: {
                post: async () => {
                  return {data: {success: true}}
                },
              },
            },
          }
        },
      },
    },
  }
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

const setSelectValue = (select: HTMLSelectElement | undefined, value: string) => {
  expect(select).toBeInstanceOf(HTMLSelectElement)
  if (!select) {
    return
  }
  select.value = value
  select.dispatchEvent(new Event('change', {bubbles: true}))
}

const renderChangesPage = async () => {
  const {AdminDataSourceTrackingChanges} = await import('./+changes.tsx')
  const queryClient = new QueryClient({defaultOptions: {mutations: {retry: false}, queries: {retry: false}}})
  const container = document.createElement('div')
  document.body.appendChild(container)
  const dispose = render(() => {
    return (
      <QueryClientProvider client={queryClient}>
        <AdminDataSourceTrackingChanges />
      </QueryClientProvider>
    )
  }, container)

  await waitForCondition(() => {
    expect(container.textContent).toContain('article-1')
  })

  return {container, dispose, queryClient}
}

beforeEach(() => {
  document.body.innerHTML = ''
  mockState.changesQueries = []
  mockState.dataSourceId = 'source-1'
  mockState.nextCursor = null
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('data source tracking changes page', () => {
  test('renders deleted changes and sends change/run filters to the API', async () => {
    const {container, dispose, queryClient} = await renderChangesPage()

    try {
      expect(container.textContent).toContain('Tracking changes')
      expect(container.textContent).toContain('article-1')
      expect(container.textContent).toContain('pmid:1')
      expect(container.textContent).toContain('Manual full range')

      const articleLink = container.querySelector<HTMLAnchorElement>('a[href="/articles/article-1"]')
      expect(articleLink).toBeInstanceOf(HTMLAnchorElement)

      const selects = Array.from(container.querySelectorAll<HTMLSelectElement>('select'))
      setSelectValue(selects[0], 'source_record_deleted')
      setSelectValue(selects[1], 'manual_full_range')

      await waitForCondition(() => {
        expect(mockState.changesQueries).toContainEqual({
          changeKind: 'source_record_deleted',
          limit: 50,
          runKind: 'manual_full_range',
        })
      })
    } finally {
      dispose()
      queryClient.clear()
      container.remove()
    }
  })

  test('requests the next change-history page from returned pagination metadata', async () => {
    mockState.nextCursor = 'cursor-next-page'
    const {container, dispose, queryClient} = await renderChangesPage()

    try {
      const nextButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => {
        return button.textContent === 'Next'
      })
      expect(nextButton).toBeInstanceOf(HTMLButtonElement)
      nextButton?.click()

      await waitForCondition(() => {
        expect(mockState.changesQueries).toContainEqual({after: 'cursor-next-page', limit: 50})
      })
    } finally {
      dispose()
      queryClient.clear()
      container.remove()
    }
  })
})
