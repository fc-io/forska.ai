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
    fullTextStrategyId: 'fts-none',
    fullTextStrategyLabel: 'no full text',
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

  test('stays hidden for paused jobs whose failing rows the server reports inactive', async () => {
    mockState.jobs = [
      buildJob({
        id: 'job-paused-limited',
        projectName: 'cov 7',
        providerHealth: buildProviderHealth({isActive: false, jobId: 'job-paused-limited'}),
        status: 'paused',
      }),
      buildJob({
        id: 'job-paused-timeout',
        projectName: 'cov 6 | original prompt',
        providerHealth: buildProviderHealth({
          failureKind: 'timeout',
          failureMessage: 'thread/start timed out',
          isActive: false,
          jobId: 'job-paused-timeout',
          retryAfterAt: null,
        }),
        status: 'paused',
      }),
      buildJob({id: 'job-running', projectName: 'cov 8'}),
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

describe('judgment jobs list stop condition hint', () => {
  test('shows the stop reason or the active stop conditions under the job status', async () => {
    mockState.jobs = [
      {
        ...buildJob({id: 'job-stopped', projectName: 'Stopped project', status: 'paused'}),
        stopAfterArticles: 2000,
        stopReason: 'article_cap',
      },
      {
        ...buildJob({id: 'job-limited', projectName: 'Limited project'}),
        stopAfterTotalTokens: 5000000,
        stopWhenHumanAnsweredDone: true,
      },
      buildJob({id: 'job-plain', projectName: 'Plain project'}),
    ]
    const {cleanup, container} = await renderJobsPage()
    const getRowText = (projectName: string) => {
      return (
        Array.from(container.querySelectorAll('tbody tr')).find((row) => {
          return row.textContent?.includes(projectName)
        })?.textContent ?? ''
      )
    }

    try {
      expect(getRowText('Stopped project')).toContain('stop: 2,000 articles reached')
      expect(getRowText('Limited project')).toContain('stop: human-answered · ≤ 5,000,000 tokens')
      expect(getRowText('Plain project')).not.toContain('stop:')
    } finally {
      cleanup()
    }
  })
})

describe('judgment jobs list full-text strategy', () => {
  test('shows each job full-text strategy label under the project name', async () => {
    mockState.jobs = [
      {
        ...buildJob({id: 'job-strategy', projectName: 'Strategy project'}),
        fullTextStrategyId: 'fts-0123456789abcdef',
        fullTextStrategyLabel: 'MinerU 4 · figures: none · single chunk',
      },
      buildJob({id: 'job-plain', projectName: 'Plain project'}),
    ]
    const {cleanup, container} = await renderJobsPage()
    const getRowText = (projectName: string) => {
      return (
        Array.from(container.querySelectorAll('tbody tr')).find((row) => {
          return row.textContent?.includes(projectName)
        })?.textContent ?? ''
      )
    }

    try {
      expect(getRowText('Strategy project')).toContain('Full-text strategy: MinerU 4 · figures: none · single chunk')
      expect(getRowText('Plain project')).toContain('Full-text strategy: no full text')
    } finally {
      cleanup()
    }
  })
})

describe('judgment jobs list full-text gate banner', () => {
  test('shows gate errors as blocking and warnings separately with links to the affected jobs', async () => {
    const windowError =
      "Model Judge (sglang) accepts 32,768 prompt tokens, fewer than the chunk policy's 48,000-token prompt size. Choose a smaller prompt size or another model, or correct its context window on the Models page."
    const healthWarning =
      'PDF-to-text model MinerU standard: The last health check of MinerU failed at 2026-10-17 20:15 UTC: connect ECONNREFUSED. Conversion will not run until the server is reachable.'

    mockState.jobs = [
      {
        ...buildJob({id: 'job-blocked', projectName: 'Blocked project', status: 'paused'}),
        fullTextGate: {errors: [windowError], warnings: [healthWarning]},
      },
      {...buildJob({id: 'job-plain', projectName: 'Plain project'}), fullTextGate: {errors: [], warnings: []}},
    ]
    const {cleanup, container} = await renderJobsPage()

    try {
      const banner = container.querySelector('[data-testid="jobs-full-text-gate-banner"]')
      const groups = Array.from(banner?.querySelectorAll('[data-tone]') ?? []).map((group) => {
        return {
          links: Array.from(group.querySelectorAll('a')).map((link) => {
            return link.getAttribute('href')
          }),
          text: group.querySelector('p')?.textContent,
          tone: group.getAttribute('data-tone'),
        }
      })

      expect(banner?.className).toContain('border-rose-200 bg-rose-50 text-rose-900')
      expect(banner?.textContent).toContain('Full-text checks')
      expect(groups).toEqual([
        {links: ['/admin/jobs/job-blocked'], text: `Blocks judging: ${windowError}`, tone: 'rose'},
        {links: ['/admin/jobs/job-blocked'], text: `Warning: ${healthWarning}`, tone: 'amber'},
      ])
    } finally {
      cleanup()
    }
  })

  test('stays hidden when no job has full-text messages', async () => {
    mockState.jobs = [buildJob({id: 'job-plain', projectName: 'Plain project'})]
    const {cleanup, container} = await renderJobsPage()

    try {
      expect(container.querySelector('[data-testid="jobs-full-text-gate-banner"]')).toBeNull()
    } finally {
      cleanup()
    }
  })
})
