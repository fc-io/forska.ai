// @vitest-environment happy-dom

import {QueryClient, QueryClientProvider} from '@tanstack/solid-query'
import type {ParentProps} from 'solid-js'
import {render} from 'solid-js/web'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'

import type {JudgmentJobProviderHealth} from './jobsPageShared.ts'

type MockLinkProps = ParentProps<{class?: string; params?: {id?: string}; to: string}>

const mockState = vi.hoisted(() => {
  return {jobs: [] as Array<Record<string, unknown>>}
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
  const edenMethods = new Set(['delete', 'get', 'patch', 'post', 'put'])
  const getEdenResponse = (path: string) => {
    return path === 'api.judgmentsjobs.get'
      ? {data: {data: mockState.jobs, error: null}, error: null, status: 200}
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

const buildJob = ({
  badges = ['Healthy'],
  id,
  projectName,
  providerHealth = null,
  status = 'running',
}: {
  badges?: string[]
  id: string
  projectName: string
  providerHealth?: JudgmentJobProviderHealth | null
  status?: string
}) => {
  return {
    createdAt: '2026-10-02T12:00:00.000Z',
    error: null,
    health: {badges, isHealthy: badges.length === 1 && badges[0] === 'Healthy'},
    id,
    importFailureCount: 0,
    lastImportCompletedAt: null,
    lastImportError: null,
    lastImportErrorAt: null,
    lastImportExitCode: null,
    lastImportStartedAt: null,
    pauseRequestedAt: null,
    projectId: `project-${id}`,
    projectName,
    providerHealth,
    quarantineReason: null,
    quarantinedAt: null,
    status,
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

const getProviderBanner = (container: HTMLElement) => {
  return Array.from(container.querySelectorAll('[role="alert"]')).find((element) => {
    return element.textContent?.includes('LLM provider failing')
  })
}

const renderJobsPage = async () => {
  const {AdminJobs} = await import('./+index.tsx')
  const queryClient = new QueryClient({defaultOptions: {mutations: {retry: false}, queries: {retry: false}}})
  const container = document.createElement('div')
  document.body.appendChild(container)
  const dispose = render(() => {
    return (
      <QueryClientProvider client={queryClient}>
        <AdminJobs />
      </QueryClientProvider>
    )
  }, container)

  await waitForCondition(() => {
    expect(container.querySelectorAll('tbody tr').length).toBe(mockState.jobs.length)
    expect(container.textContent).toContain('Health Summary')
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
  mockState.jobs = []
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('judgment jobs list provider health banner', () => {
  test('shows the failing provider with its message, retry-after time and a link to the affected job', async () => {
    mockState.jobs = [
      buildJob({
        badges: ['Provider Failing'],
        id: 'job-limited',
        projectName: 'cov 6 | 4',
        providerHealth: buildProviderHealth(),
      }),
      buildJob({id: 'job-healthy', projectName: 'Healthy project'}),
    ]
    const {cleanup, container} = await renderJobsPage()

    try {
      const banner = getProviderBanner(container)
      const bannerText = banner?.textContent ?? ''
      const affectedJobLinks = Array.from(banner?.querySelectorAll('a') ?? [])

      expect(banner).toBeDefined()
      expect(banner?.className).toContain('border-rose-200 bg-rose-50 text-rose-900')
      expect(bannerText).toContain('Usage limit reached')
      expect(bannerText).toContain(codexUsageLimitMessage)
      expect(bannerText).toContain('Provider says try again at 2026-10-03 21:33')
      expect(bannerText).toContain('Affected jobs:')
      expect(bannerText).not.toContain('Healthy project')
      expect(
        affectedJobLinks.map((link) => {
          return {href: link.getAttribute('href'), text: link.textContent}
        }),
      ).toEqual([{href: '/admin/jobs/job-limited', text: 'cov 6 | 4Running'}])
      expect(container.textContent).toContain('Provider Failing')
    } finally {
      cleanup()
    }
  })

  test('truncates long provider messages to 300 characters', async () => {
    const longMessage = `usage limit ${'x'.repeat(400)}`
    mockState.jobs = [
      buildJob({
        id: 'job-limited',
        projectName: 'Long message project',
        providerHealth: buildProviderHealth({failureMessage: longMessage, retryAfterAt: null}),
      }),
    ]
    const {cleanup, container} = await renderJobsPage()

    try {
      const bannerText = getProviderBanner(container)?.textContent ?? ''

      expect(bannerText).toContain(`${longMessage.slice(0, 299)}…`)
      expect(bannerText).not.toContain(longMessage)
      expect(bannerText).not.toContain('Provider says try again at')
    } finally {
      cleanup()
    }
  })

  test('stays hidden when every job is healthy or its provider has recovered', async () => {
    mockState.jobs = [
      buildJob({id: 'job-healthy', projectName: 'Healthy project'}),
      buildJob({
        id: 'job-recovered',
        projectName: 'Recovered project',
        providerHealth: buildProviderHealth({
          consecutiveFailureCount: 0,
          isActive: false,
          recoveredAt: new Date().toISOString(),
          status: 'recovered',
        }),
      }),
    ]
    const {cleanup, container} = await renderJobsPage()

    try {
      expect(getProviderBanner(container)).toBeUndefined()
      expect(container.textContent).not.toContain('LLM provider failing')
    } finally {
      cleanup()
    }
  })
})
