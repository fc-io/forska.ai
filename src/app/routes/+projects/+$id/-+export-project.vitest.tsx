// @vitest-environment happy-dom

import {QueryClient, QueryClientProvider} from '@tanstack/solid-query'
import type {Component, JSX, ParentProps} from 'solid-js'
import {splitProps} from 'solid-js'
import {Dynamic} from 'solid-js/web'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'

type MockLinkProps = ParentProps<{class?: string; params?: {id?: string}; to: string}>
type MockButtonProps = ParentProps<
  {as?: keyof JSX.IntrinsicElements | Component<Record<string, unknown>>} & Record<string, unknown>
>

const mockState = vi.hoisted(() => {
  return {
    projectAccessQuery: {
      data: {archived: false, humanJudgmentMode: 'prompt' as const, id: 'project-1', name: 'Transfer project'},
      error: null,
      isError: false,
      isLoading: false,
    },
    routeProjectId: 'project-1',
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
              return {id: mockState.routeProjectId}
            }
          },
        }
      }
    },
  }
})

vi.mock('../projectAccessGuard', () => {
  return {
    useProjectAccessQuery: () => {
      return mockState.projectAccessQuery
    },
  }
})

vi.mock('../../../../services/apiClient.ts', () => {
  return {
    apiClient: {
      api: {
        projects: {
          export: () => {
            return {get: vi.fn()}
          },
        },
      },
    },
  }
})

vi.mock('../../../../components/ui/button', () => {
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

const originalCreateObjectURL = Reflect.get(URL, 'createObjectURL')
const originalRevokeObjectURL = Reflect.get(URL, 'revokeObjectURL')
let anchorClickSpy: ReturnType<typeof vi.spyOn>

const getQueryClient = () => {
  return new QueryClient({defaultOptions: {mutations: {retry: false}, queries: {retry: false}}})
}

const getJsonResponse = (body: unknown, status = 200) => {
  return new Response(JSON.stringify(body), {headers: {'content-type': 'application/json'}, status})
}

const getZipResponse = () => {
  return new Response('zip-body', {
    headers: {
      'content-disposition': 'attachment; filename="project-transfer-project-1.zip"',
      'content-type': 'application/zip',
    },
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

const renderExportProject = async () => {
  const {render} = await import('solid-js/web')
  const {ExportProject} = await import('./+export-project.tsx')
  const queryClient = getQueryClient()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const dispose = render(() => {
    return (
      <QueryClientProvider client={queryClient}>
        <ExportProject />
      </QueryClientProvider>
    )
  }, container)

  await Promise.resolve()

  return {container, dispose, queryClient}
}

describe('export project page', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    window.history.replaceState({}, '', 'http://localhost:3000/projects/project-1/export-project')
    mockState.routeProjectId = 'project-1'
    mockState.projectAccessQuery = {
      data: {archived: false, humanJudgmentMode: 'prompt', id: 'project-1', name: 'Transfer project'},
      error: null,
      isError: false,
      isLoading: false,
    }
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

  test('shows export counts, source metadata wording, and exports with omit as the default', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockImplementation((_input, init) => {
      const method = init?.method ?? 'GET'

      return Promise.resolve(
        method === 'POST'
          ? getZipResponse()
          : getJsonResponse({
              data: {
                articleCount: 12,
                defaultRawArticleProvenanceMode: 'omit',
                humanJudgmentCount: 4,
                judgmentCount: 34,
                promptHumanJudgmentCount: 3,
                summaryHumanJudgmentCount: 1,
              },
              error: null,
            }),
      )
    })
    const {container, dispose, queryClient} = await renderExportProject()

    try {
      await waitForCondition(() => {
        expect(container.textContent).toContain('Transfer project')
        expect(container.textContent).toContain('Articles exported')
        expect(container.textContent).toContain('12')
        expect(container.textContent).toContain('LLM judgments exported')
        expect(container.textContent).toContain('34')
        expect(container.textContent).toContain('Human judgments exported')
        expect(container.textContent).toContain('3 prompt-level and 1 summary human judgments')
        expect(container.textContent).toContain('Leave out source import metadata')
        expect(container.textContent).toContain('Include source import metadata')
        expect(container.textContent).toContain('Not exported: Original article source JSON')
      })

      const omitInput = container.querySelector<HTMLInputElement>('input[value="omit"]')
      const exportButton = Array.from(container.querySelectorAll('button')).find((button) => {
        return button.textContent?.trim() === 'Export Project'
      })

      expect(omitInput?.checked).toBe(true)
      exportButton?.click()

      await waitForCondition(() => {
        expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:3001/api/projects/project-1/export-project', {
          body: JSON.stringify({rawArticleProvenanceMode: 'omit'}),
          credentials: 'include',
          headers: {'content-type': 'application/json'},
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
