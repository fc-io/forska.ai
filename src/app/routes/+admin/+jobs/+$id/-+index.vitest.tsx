// @vitest-environment happy-dom

import {QueryClient, QueryClientProvider} from '@tanstack/solid-query'
import {formatDate} from 'date-fns'
import type {ParentProps} from 'solid-js'
import {render} from 'solid-js/web'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'

import type {JudgmentJobProviderHealth} from '../jobsPageShared.ts'

type MockLinkProps = ParentProps<{class?: string; params?: {id?: string}; to: string}>

const mockState = vi.hoisted(() => {
  return {
    calls: [] as Array<{args: unknown[]; path: string}>,
    job: {} as Record<string, unknown>,
    jobId: 'job-limited',
    responses: {} as Record<string, unknown>,
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
              ? async (...methodArgs: unknown[]) => {
                  const path = [...segments, property].join('.')

                  mockState.calls.push({args: methodArgs, path})
                  return getEdenResponse(path)
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
  mockState.calls = []
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

const getJobPatchCalls = () => {
  return mockState.calls.filter((call) => {
    return call.path === `api.judgmentsjobs.:${mockState.jobId}.patch`
  })
}

const getPatchResponse = (data: Record<string, unknown>) => {
  return {data: {data: {jobId: mockState.jobId, ...data}, error: null}, error: null, status: 200}
}

const findButtonByText = (root: ParentNode, text: string) => {
  return Array.from(root.querySelectorAll('button')).find((candidate) => {
    return candidate.textContent?.trim() === text
  })
}

const openPauseOptions = async (container: HTMLElement) => {
  const trigger = container.querySelector('button[aria-label="Pause options"]')

  expect(trigger).toBeInstanceOf(HTMLButtonElement)
  ;(trigger as HTMLButtonElement).click()
  await waitForCondition(() => {
    expect(document.body.textContent).toContain('Pause automatically when')
  })

  return trigger as HTMLButtonElement
}

describe('judgment job stop conditions', () => {
  test('the main segment still pauses the running job right away', async () => {
    mockState.job = {...buildJob(null), status: 'running'}
    mockState.responses[`api.judgmentsjobs.:${mockState.jobId}.patch`] = getPatchResponse({status: 'paused'})
    const {cleanup, container} = await renderJobDetailPage()

    try {
      clickButtonByText(container, 'Pause Job')
      await waitForCondition(() => {
        expect(getJobPatchCalls()).toHaveLength(1)
      })
      expect(getJobPatchCalls()[0]?.args[0]).toEqual({status: 'paused'})
    } finally {
      cleanup()
    }
  })

  test('the chevron opens the pause menu with the stop conditions', async () => {
    mockState.job = {
      ...buildJob(null),
      admittedArticleCount: 1234,
      status: 'running',
      stopAfterArticles: 2000,
      stopWhenHumanAnsweredDone: true,
      totalTokenUsage: {totalTokens: 98765},
    }
    const {cleanup, container} = await renderJobDetailPage()

    try {
      const trigger = await openPauseOptions(container)
      const menuText = document.body.textContent ?? ''

      expect(trigger.getAttribute('aria-expanded')).toBe('true')
      expect(trigger.getAttribute('aria-haspopup')).not.toBeNull()
      expect(findButtonByText(document.body, 'Pause now')).toBeInstanceOf(HTMLButtonElement)
      expect(menuText).toContain('1,234 of 2,000 admitted')
      expect(menuText).toContain('Pause when human-answered articles are done')
      expect(menuText).toContain('Current total: 98,765 tokens')
      expect(menuText).toContain('Tomorrow 07:00')
      expect(container.textContent).toContain('≤ 2,000 articles')
      expect(container.textContent).toContain('human-answered')
    } finally {
      cleanup()
    }
  })

  test('editing the article cap saves it with a PATCH and shows that it saved', async () => {
    mockState.job = {...buildJob(null), status: 'running'}
    mockState.responses[`api.judgmentsjobs.:${mockState.jobId}.patch`] = getPatchResponse({stopAfterArticles: 2500})
    const {cleanup, container} = await renderJobDetailPage()

    try {
      await openPauseOptions(container)

      const input = document.body.querySelector('input[aria-label="Pause after this many articles"]')

      expect(input).toBeInstanceOf(HTMLInputElement)
      ;(input as HTMLInputElement).value = '2500'
      input?.dispatchEvent(new InputEvent('input', {bubbles: true, data: '2500', inputType: 'insertText'}))
      input?.dispatchEvent(new FocusEvent('blur'))

      await waitForCondition(() => {
        expect(getJobPatchCalls()).toHaveLength(1)
        expect(document.body.textContent).toContain('Saved')
      })
      expect(getJobPatchCalls()[0]?.args[0]).toEqual({stopAfterArticles: 2500})
    } finally {
      cleanup()
    }
  })

  test('shows the stop reason banner after a stop condition paused the job', async () => {
    mockState.job = {
      ...buildJob(null),
      admittedArticleCount: 1500,
      stopAfterArticles: 3000,
      stopReason: 'article_cap',
      stopReasonAt: new Date(2026, 9, 11, 18, 0, 0).toISOString(),
    }
    const {cleanup, container} = await renderJobDetailPage()

    try {
      const banner = Array.from(container.querySelectorAll('[role="status"]')).find((candidate) => {
        return candidate.textContent?.includes('Paused by stop condition')
      })

      expect(banner?.textContent).toContain('Paused by stop condition: 3,000 articles reached')
      expect(banner?.textContent).toContain('Paused at 2026-10-11 18:00:00')
      expect(banner?.textContent).toContain('Resume to continue judging.')
      expect(banner?.classList.contains('border-amber-200')).toBe(true)
      expect(banner?.classList.contains('bg-amber-50')).toBe(true)
    } finally {
      cleanup()
    }
  })

  test('disables Resume with the hint while a stop condition is still satisfied', async () => {
    mockState.job = {
      ...buildJob(null),
      admittedArticleCount: 2000,
      stopAfterArticles: 2000,
      stopReason: 'article_cap',
      stopReasonAt: new Date(2026, 9, 11, 18, 0, 0).toISOString(),
    }
    const {cleanup, container} = await renderJobDetailPage()

    try {
      const startButton = findButtonByText(container, 'Start Job')

      expect(startButton?.disabled).toBe(true)
      expect(startButton?.title).toBe('Raise or clear the article cap stop condition to resume.')
      expect(container.textContent).toContain('Paused by stop condition: 2,000 articles reached')
      expect(container.textContent).toContain('Raise or clear the article cap stop condition to resume.')

      await openPauseOptions(container)

      expect(findButtonByText(document.body, 'Resume')?.disabled).toBe(true)
    } finally {
      cleanup()
    }
  })

  test('enables Resume once the condition no longer blocks it', async () => {
    mockState.job = {...buildJob(null), admittedArticleCount: 2000, stopAfterArticles: 2500, stopReason: 'article_cap'}
    const {cleanup, container} = await renderJobDetailPage()

    try {
      expect(findButtonByText(container, 'Start Job')?.disabled).toBe(false)
      expect(container.textContent).not.toContain('Raise or clear the article cap stop condition to resume.')
    } finally {
      cleanup()
    }
  })
})
