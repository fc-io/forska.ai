// @vitest-environment happy-dom

import {QueryClient, QueryClientProvider} from '@tanstack/solid-query'
import {formatDate} from 'date-fns'
import type {ParentProps} from 'solid-js'
import {render} from 'solid-js/web'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'

import type {JudgmentJobProviderHealth} from '../jobsPageShared.ts'

type MockLinkProps = ParentProps<{class?: string; params?: {id?: string}; to: string}>

const mockState = vi.hoisted(() => {
  return {job: {} as Record<string, unknown>, jobId: 'job-limited', responses: {} as Record<string, unknown>}
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
              return {id: mockState.jobId}
            }
          },
        }
      }
    },
    useNavigate: () => {
      return () => {
        return Promise.resolve()
      }
    },
  }
})

vi.mock('../../../../../services/apiClient.ts', () => {
  const edenMethods = new Set(['delete', 'get', 'patch', 'post', 'put'])
  const getEdenResponse = (path: string) => {
    return path in mockState.responses
      ? mockState.responses[path]
      : path === `api.judgmentsjobs.:${mockState.jobId}.get`
        ? {data: mockState.job, error: null, status: 200}
        : path === 'api.judgmentsjobs-unassessed-count.get'
          ? {data: {count: 0}, error: null, status: 200}
          : path === 'api.projects.:project-limited.get'
            ? {data: {id: 'project-limited', model: null, name: 'cov 6 | 4'}, error: null, status: 200}
            : {data: null, error: {message: `Not mocked in test: ${path}`}, status: 404}
  }
  const createEdenNode = (segments: string[]): unknown => {
    return new Proxy(
      () => {
        return undefined
      },
      {
        apply: (_target, _thisArg, args: unknown[]) => {
          return createEdenNode([...segments, `:${Object.values((args[0] ?? {}) as object).join(',')}`])
        },
        get: (_target, property) => {
          return typeof property !== 'string' || property === 'then'
            ? undefined
            : edenMethods.has(property)
              ? async () => {
                  return getEdenResponse([...segments, property].join('.'))
                }
              : createEdenNode([...segments, property])
        },
      },
    )
  }

  return {apiClient: createEdenNode([])}
})

const codexUsageLimitMessage =
  'codex app-server: turn failed: You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 3rd, 2026 9:33 PM.'
const hourMs = 60 * 60 * 1000

const buildProviderHealth = (overrides: Partial<JudgmentJobProviderHealth> = {}): JudgmentJobProviderHealth => {
  return {
    consecutiveFailureCount: 42,
    failureCode: 'provider_error',
    failureKind: 'usage_limit',
    failureMessage: codexUsageLimitMessage,
    firstFailedAt: new Date(2026, 9, 3, 5, 0, 0).toISOString(),
    isActive: true,
    jobId: 'job-limited',
    lastFailedAt: new Date(2026, 9, 3, 13, 0, 0).toISOString(),
    lastSuccessAt: null,
    modelId: 'model-gpt',
    recoveredAt: null,
    retryAfterAt: new Date(2026, 9, 3, 21, 33).toISOString(),
    status: 'failing',
    totalFailureCount: 42,
    updatedAt: new Date(2026, 9, 3, 13, 0, 0).toISOString(),
    ...overrides,
  }
}

const buildRecoveredProviderHealth = (recoveredAt: Date) => {
  return buildProviderHealth({
    consecutiveFailureCount: 0,
    failureKind: 'rate_limited',
    failureMessage: '429 Too Many Requests',
    isActive: false,
    lastSuccessAt: recoveredAt.toISOString(),
    recoveredAt: recoveredAt.toISOString(),
    retryAfterAt: null,
    status: 'recovered',
    totalFailureCount: 5,
  })
}

const buildJob = (providerHealth: JudgmentJobProviderHealth | null | undefined) => {
  return {
    createdAt: '2026-10-02T12:00:00.000Z',
    error: [],
    id: mockState.jobId,
    importFailureCount: 0,
    judgingRuntime: {enabled: true, reason: null},
    projectId: 'project-limited',
    projectName: 'cov 6 | 4',
    providerHealth,
    status: 'paused',
    storageState: 'active',
    updatedAt: '2026-10-03T13:00:00.000Z',
  }
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

const renderJobDetailPage = async () => {
  const {AdminJudgmentJobDetail} = await import('./+index.tsx')
  const queryClient = new QueryClient({defaultOptions: {mutations: {retry: false}, queries: {retry: false}}})
  const container = document.createElement('div')
  document.body.appendChild(container)
  const dispose = render(() => {
    return (
      <QueryClientProvider client={queryClient}>
        <AdminJudgmentJobDetail />
      </QueryClientProvider>
    )
  }, container)

  await waitForCondition(() => {
    expect(container.textContent).toContain(mockState.jobId)
    expect(container.textContent).toContain('Work Definition')
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
  mockState.job = buildJob(null)
  mockState.responses = {}
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('judgment job detail provider health notices', () => {
  test('shows the usage limit banner with the raw message, failure meta, retry-after time and guidance', async () => {
    mockState.job = buildJob(buildProviderHealth())
    const {cleanup, container} = await renderJobDetailPage()

    try {
      const banner = container.querySelector('[role="alert"]')
      const bannerText = banner?.textContent ?? ''

      expect(banner).not.toBeNull()
      expect(banner?.className).toContain('border-rose-200 bg-rose-50 text-rose-900')
      expect(bannerText).toContain('Usage limit reached')
      expect(bannerText).toContain(codexUsageLimitMessage)
      expect(bannerText).toContain('Since 2026-10-03 05:00:00, 42 failed attempts, last at 2026-10-03 13:00:00')
      expect(bannerText).toContain('Provider says try again at 2026-10-03 21:33')
      expect(bannerText).toContain(
        'Buy credits or wait for the limit to reset; the job resumes by itself once the provider accepts calls.',
      )
      expect(container.textContent).not.toContain('Provider recovered at')
    } finally {
      cleanup()
    }
  })

  test('uses the amber tone and skips the retry line for a network failure without retry-after', async () => {
    mockState.job = buildJob(
      buildProviderHealth({failureKind: 'network', failureMessage: 'fetch failed: ECONNREFUSED', retryAfterAt: null}),
    )
    const {cleanup, container} = await renderJobDetailPage()

    try {
      const banner = container.querySelector('[role="alert"]')
      const bannerText = banner?.textContent ?? ''

      expect(banner?.className).toContain('border-amber-200 bg-amber-50 text-amber-900')
      expect(bannerText).toContain('Network error')
      expect(bannerText).toContain('fetch failed: ECONNREFUSED')
      expect(bannerText).toContain('Check that the endpoint is running and reachable.')
      expect(bannerText).not.toContain('Provider says try again at')
    } finally {
      cleanup()
    }
  })

  test('shows a recovered note when the provider recovered within the last 24 hours', async () => {
    const recoveredAt = new Date(Date.now() - 2 * hourMs)
    mockState.job = buildJob(buildRecoveredProviderHealth(recoveredAt))
    const {cleanup, container} = await renderJobDetailPage()

    try {
      const note = container.querySelector('[role="status"]')

      expect(note?.textContent).toBe(
        `Provider recovered at ${formatDate(recoveredAt, 'yyyy-MM-dd HH:mm:ss')} after 5 failures (Rate limited)`,
      )
      expect(note?.classList.contains('border-sky-200')).toBe(true)
      expect(note?.classList.contains('bg-sky-50')).toBe(true)
      expect(note?.classList.contains('text-sky-900')).toBe(true)
      expect(container.querySelector('[role="alert"]')).toBeNull()
    } finally {
      cleanup()
    }
  })

  test('shows nothing when the recovery is older than 24 hours', async () => {
    mockState.job = buildJob(buildRecoveredProviderHealth(new Date(Date.now() - 25 * hourMs)))
    const {cleanup, container} = await renderJobDetailPage()

    try {
      expect(container.textContent).not.toContain('Provider recovered at')
      expect(container.querySelector('[role="alert"]')).toBeNull()
    } finally {
      cleanup()
    }
  })

  test('shows nothing when the job has no provider health record', async () => {
    const {cleanup, container} = await renderJobDetailPage()

    try {
      expect(container.querySelector('[role="alert"]')).toBeNull()
      expect(container.querySelector('[role="status"]')).toBeNull()
      expect(container.textContent).not.toContain('Usage limit reached')
      expect(container.textContent).not.toContain('Provider recovered at')
    } finally {
      cleanup()
    }
  })

  test('shows nothing when an older server omits the provider health field', async () => {
    mockState.job = buildJob(undefined)
    const {cleanup, container} = await renderJobDetailPage()

    try {
      expect(container.querySelector('[role="alert"]')).toBeNull()
      expect(container.textContent).not.toContain('Provider recovered at')
    } finally {
      cleanup()
    }
  })
})

const clickButtonByText = (container: HTMLElement, text: string) => {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) => {
    return candidate.textContent?.trim() === text
  })

  expect(button).toBeInstanceOf(HTMLButtonElement)
  button?.click()
}

describe('judgment job detail action feedback', () => {
  test('shows a failed repair result as an error instead of a success notice', async () => {
    const message = 'SQLite job DB is missing. Run Preflight after restoring the file.'
    mockState.responses[`api.judgmentsjobs.:${mockState.jobId}.preflight.post`] = {
      data: {action: 'preflight', changes: {}, job: {}, message, ok: false, preflight: null},
      error: null,
      status: 200,
    }
    const {cleanup, container} = await renderJobDetailPage()

    try {
      clickButtonByText(container, 'Run Preflight')
      await waitForCondition(() => {
        expect(container.textContent).toContain(message)
      })

      const notice = Array.from(container.querySelectorAll('div'))
        .filter((candidate) => {
          return candidate.textContent === message
        })
        .at(-1)

      expect(notice?.className).toContain('border-red-200')
      expect(notice?.className).not.toContain('border-green-200')
    } finally {
      cleanup()
    }
  })

  test('shows the server error when deleting the job is refused', async () => {
    const message = 'Delete Job stopped safely for job-limited. Local SQLite data was left in place.'
    mockState.responses[`api.judgmentsjobs.:${mockState.jobId}.delete`] = {data: null, error: {message}, status: 409}
    vi.stubGlobal('confirm', () => {
      return true
    })
    const {cleanup, container} = await renderJobDetailPage()

    try {
      clickButtonByText(container, 'Delete Job')
      await waitForCondition(() => {
        expect(container.textContent).toContain(message)
      })
      expect(container.textContent).toContain('Delete Job')
      expect(container.textContent).not.toContain('Deleting...')
    } finally {
      cleanup()
    }
  })
})
