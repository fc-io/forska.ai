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
    fullTextStrategyId: 'fts-0123456789abcdef',
    fullTextStrategyLabel: 'MinerU 4 · figures: none · single chunk',
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
    mockState.job = {...buildJob(buildProviderHealth()), status: 'running'}
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
    mockState.job = {
      ...buildJob(
        buildProviderHealth({failureKind: 'network', failureMessage: 'fetch failed: ECONNREFUSED', retryAfterAt: null}),
      ),
      status: 'running',
    }
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

  test('shows nothing for a paused job whose failing row the server reports inactive', async () => {
    mockState.job = buildJob(buildProviderHealth({isActive: false}))
    const {cleanup, container} = await renderJobDetailPage()

    try {
      expect(container.querySelector('[role="alert"]')).toBeNull()
      expect(container.textContent).not.toContain('Usage limit reached')
      expect(container.textContent).not.toContain('Provider recovered at')
    } finally {
      cleanup()
    }
  })

  test('shows no recovered note after a resume reset without a provider success', async () => {
    const resumedAt = new Date(Date.now() - hourMs)
    mockState.job = {
      ...buildJob({
        ...buildRecoveredProviderHealth(resumedAt),
        lastSuccessAt: new Date(Date.now() - 15 * 24 * hourMs).toISOString(),
      }),
      status: 'running',
    }
    const {cleanup, container} = await renderJobDetailPage()

    try {
      expect(container.querySelector('[role="alert"]')).toBeNull()
      expect(container.textContent).not.toContain('Provider recovered at')
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

describe('judgment job detail full-text strategy', () => {
  test('shows the job full-text strategy label in the work definition', async () => {
    const {cleanup, container} = await renderJobDetailPage()

    try {
      expect(container.textContent).toContain('Full-text strategy')
      expect(container.textContent).toContain('MinerU 4 · figures: none · single chunk')
    } finally {
      cleanup()
    }
  })
})

describe('judgment job detail full-text gate', () => {
  test('shows the blocking full-text errors and warnings the jobs list shows', async () => {
    const windowError =
      "Model Judge (sglang) accepts 32,768 prompt tokens, fewer than the chunk policy's 48,000-token prompt size. Choose a smaller prompt size or another model, or correct its context window on the Models page."
    const healthWarning =
      'PDF-to-text model MinerU standard: The last health check of MinerU failed at 2026-10-17 20:15 UTC: connect ECONNREFUSED. Conversion will not run until the server is reachable.'

    mockState.job = {...buildJob(null), fullTextGate: {errors: [windowError], warnings: [healthWarning]}}
    const {cleanup, container} = await renderJobDetailPage()

    try {
      const notice = container.querySelector('[data-testid="job-full-text-gate"]')
      const blocking = notice?.querySelector('[role="alert"]')

      expect(blocking?.className).toContain('border-rose-200 bg-rose-50 text-rose-900')
      expect(blocking?.textContent).toBe(`Full-text checks block judging${windowError}`)
      expect(notice?.textContent).toContain(`Full-text warnings${healthWarning}`)
    } finally {
      cleanup()
    }
  })

  test('shows no full-text notice when the gate is empty or missing', async () => {
    mockState.job = {...buildJob(null), fullTextGate: {errors: [], warnings: []}}
    const empty = await renderJobDetailPage()

    try {
      expect(empty.container.querySelector('[data-testid="job-full-text-gate"]')).toBeNull()
    } finally {
      empty.cleanup()
    }
  })
})

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
    expect(getMenuItem('Pause after … articles')).toBeInstanceOf(HTMLButtonElement)
  })

  return trigger as HTMLButtonElement
}

const getMenuItem = (label: string) => {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>('[data-stop-menu-item]')).find((item) => {
    return item.querySelector('[data-stop-menu-label]')?.textContent?.trim() === label
  })
}

const getMenuItemValue = (label: string) => {
  return getMenuItem(label)?.querySelector('span.text-xs')?.textContent?.trim() ?? null
}

const clickMenuItem = async (label: string) => {
  await waitForCondition(() => {
    expect(getMenuItem(label)).toBeInstanceOf(HTMLButtonElement)
  })
  getMenuItem(label)?.click()
}

const stopConditionDefaultsPath = () => {
  return `api.judgmentsjobs.:${mockState.jobId}.stop-condition-defaults.get`
}

const setStopConditionDefaults = (data: Record<string, unknown> = {}) => {
  mockState.responses[stopConditionDefaultsPath()] = {
    data: {
      data: {
        admittedArticleCount: 40,
        articleCount: 1_500,
        humanJudgedArticleCount: 412,
        serverNow: new Date().toISOString(),
        totalTokens: 98_765,
        ...data,
      },
      error: null,
    },
    error: null,
    status: 200,
  }
}

const isMenuItemWithArrow = (label: string) => {
  return getMenuItem(label)?.querySelector('[data-stop-menu-arrow]') != null
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

  test('level one lists the conditions with their state and arrows only on configurable rows', async () => {
    mockState.job = {...buildJob(null), status: 'running', stopAfterArticles: 2000, stopWhenHumanAnsweredDone: true}
    setStopConditionDefaults()
    const {cleanup, container} = await renderJobDetailPage()

    try {
      const trigger = await openPauseOptions(container)

      expect(trigger.getAttribute('aria-expanded')).toBe('true')
      expect(trigger.getAttribute('aria-haspopup')).not.toBeNull()
      expect(
        Array.from(document.body.querySelectorAll('[data-stop-menu-item]')).map((item) => {
          return item.querySelector('[data-stop-menu-label]')?.textContent?.trim()
        }),
      ).toEqual([
        'Pause now',
        'Pause after … articles',
        'Pause when human-answered articles are done',
        'Pause after … tokens',
        'Pause at …',
      ])
      expect(isMenuItemWithArrow('Pause now')).toBe(false)
      expect(isMenuItemWithArrow('Pause after … articles')).toBe(true)
      expect(isMenuItemWithArrow('Pause when human-answered articles are done')).toBe(false)
      expect(isMenuItemWithArrow('Pause after … tokens')).toBe(true)
      expect(isMenuItemWithArrow('Pause at …')).toBe(true)
      expect(getMenuItemValue('Pause after … articles')).toBe('2,000')
      expect(getMenuItemValue('Pause after … tokens')).toBe('off')
      expect(getMenuItemValue('Pause at …')).toBe('off')
      expect(getMenuItem('Pause when human-answered articles are done')?.getAttribute('aria-checked')).toBe('true')
      expect(container.textContent).toContain('≤ 2,000 articles')
    } finally {
      cleanup()
    }
  })

  test('opens the article level with the defaults and goes back with the header row', async () => {
    mockState.job = {...buildJob(null), status: 'running'}
    setStopConditionDefaults()
    const {cleanup, container} = await renderJobDetailPage()

    try {
      await openPauseOptions(container)
      await clickMenuItem('Pause after … articles')
      await waitForCondition(() => {
        expect(getMenuItem('1,000 articles')).toBeInstanceOf(HTMLButtonElement)
      })

      expect(document.body.textContent).toContain('40 admitted of 1,500 articles')
      expect(getMenuItem('100 articles')).toBeInstanceOf(HTMLButtonElement)
      expect(getMenuItem('10,000 articles')).toBeUndefined()
      expect(getMenuItem('Human-judged articles (412)')?.disabled).toBe(false)
      expect(isMenuItemWithArrow('Custom…')).toBe(true)
      expect(getMenuItem('Clear')).toBeUndefined()
      expect(getMenuItem('Pause now')).toBeUndefined()

      await clickMenuItem('Pause after articles')
      await waitForCondition(() => {
        expect(getMenuItem('Pause now')).toBeInstanceOf(HTMLButtonElement)
      })
      expect(getMenuItem('1,000 articles')).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  test('picking a default saves it and returns to level one with the new value', async () => {
    mockState.job = {...buildJob(null), status: 'running'}
    mockState.responses[`api.judgmentsjobs.:${mockState.jobId}.patch`] = getPatchResponse({stopAfterArticles: 1000})
    setStopConditionDefaults()
    const {cleanup, container} = await renderJobDetailPage()

    try {
      await openPauseOptions(container)
      await clickMenuItem('Pause after … articles')
      mockState.job = {...mockState.job, stopAfterArticles: 1000}
      await clickMenuItem('1,000 articles')
      await waitForCondition(() => {
        expect(getMenuItemValue('Pause after … articles')).toBe('1,000')
      })

      expect(
        getJobPatchCalls().map((call) => {
          return call.args[0]
        }),
      ).toEqual([{stopAfterArticles: 1000}])
      expect(getMenuItem('Pause now')).toBeInstanceOf(HTMLButtonElement)
    } finally {
      cleanup()
    }
  })

  test('Custom opens a number field that saves the article cap', async () => {
    mockState.job = {...buildJob(null), status: 'running'}
    mockState.responses[`api.judgmentsjobs.:${mockState.jobId}.patch`] = getPatchResponse({stopAfterArticles: 2500})
    setStopConditionDefaults()
    const {cleanup, container} = await renderJobDetailPage()

    try {
      await openPauseOptions(container)
      await clickMenuItem('Pause after … articles')
      await clickMenuItem('Custom…')
      await waitForCondition(() => {
        expect(document.body.querySelector('input[aria-label="Pause after this many articles"]')).toBeInstanceOf(
          HTMLInputElement,
        )
      })

      const input = document.body.querySelector<HTMLInputElement>('input[aria-label="Pause after this many articles"]')

      ;(input as HTMLInputElement).value = '2500'
      input?.dispatchEvent(new InputEvent('input', {bubbles: true, data: '2500', inputType: 'insertText'}))
      mockState.job = {...mockState.job, stopAfterArticles: 2500}
      findButtonByText(document.body, 'Save')?.click()

      await waitForCondition(() => {
        expect(getMenuItemValue('Pause after … articles')).toBe('2,500')
      })
      expect(
        getJobPatchCalls().map((call) => {
          return call.args[0]
        }),
      ).toEqual([{stopAfterArticles: 2500}])
    } finally {
      cleanup()
    }
  })

  test('the deadline pick view shows a calendar with hour and minute selects and no typed date field', async () => {
    mockState.job = {...buildJob(null), status: 'running'}
    setStopConditionDefaults()
    const {cleanup, container} = await renderJobDetailPage()

    try {
      await openPauseOptions(container)
      await clickMenuItem('Pause at …')
      await waitForCondition(() => {
        expect(getMenuItem('In 1 hour')).toBeInstanceOf(HTMLButtonElement)
      })

      expect(getMenuItem('In 4 hours')).toBeInstanceOf(HTMLButtonElement)
      expect(getMenuItem('Tomorrow 07:00')).toBeInstanceOf(HTMLButtonElement)
      expect(isMenuItemWithArrow('Pick date and time…')).toBe(true)

      await clickMenuItem('Pick date and time…')
      await waitForCondition(() => {
        expect(document.body.querySelector('select[aria-label="Hour"]')).toBeInstanceOf(HTMLSelectElement)
      })

      const menu = document.body.querySelector('[role="menu"][aria-label="Pause options"]')

      expect(menu?.querySelector('[data-scope="date-picker"][data-part="table"]')).not.toBeNull()
      expect(menu?.querySelector('select[aria-label="Minute"]')).toBeInstanceOf(HTMLSelectElement)
      expect(menu?.querySelectorAll('input:not([type="hidden"])')).toHaveLength(0)
      expect(menu?.querySelector('input[type="datetime-local"]')).toBeNull()
    } finally {
      cleanup()
    }
  })

  test('the human-answered row toggles directly without a second level', async () => {
    mockState.job = {...buildJob(null), status: 'running'}
    mockState.responses[`api.judgmentsjobs.:${mockState.jobId}.patch`] = getPatchResponse({
      stopWhenHumanAnsweredDone: true,
    })
    setStopConditionDefaults()
    const {cleanup, container} = await renderJobDetailPage()

    try {
      await openPauseOptions(container)
      mockState.job = {...mockState.job, stopWhenHumanAnsweredDone: true}
      await clickMenuItem('Pause when human-answered articles are done')
      await waitForCondition(() => {
        expect(getMenuItem('Pause when human-answered articles are done')?.getAttribute('aria-checked')).toBe('true')
      })

      expect(
        getJobPatchCalls().map((call) => {
          return call.args[0]
        }),
      ).toEqual([{stopWhenHumanAnsweredDone: true}])
      expect(getMenuItem('Pause now')).toBeInstanceOf(HTMLButtonElement)
    } finally {
      cleanup()
    }
  })

  test('Pause now in the menu pauses the job and closes the menu', async () => {
    mockState.job = {...buildJob(null), status: 'running'}
    mockState.responses[`api.judgmentsjobs.:${mockState.jobId}.patch`] = getPatchResponse({status: 'paused'})
    setStopConditionDefaults()
    const {cleanup, container} = await renderJobDetailPage()

    try {
      const trigger = await openPauseOptions(container)

      await clickMenuItem('Pause now')
      await waitForCondition(() => {
        expect(getJobPatchCalls()).toHaveLength(1)
        expect(trigger.getAttribute('aria-expanded')).toBe('false')
      })
      expect(getJobPatchCalls()[0]?.args[0]).toEqual({status: 'paused'})
    } finally {
      cleanup()
    }
  })

  test('keyboard: Left and Backspace go back a level and Escape closes the menu', async () => {
    mockState.job = {...buildJob(null), status: 'running'}
    setStopConditionDefaults()
    const {cleanup, container} = await renderJobDetailPage()

    try {
      const trigger = await openPauseOptions(container)

      await clickMenuItem('Pause after … tokens')
      await waitForCondition(() => {
        expect(getMenuItem('Pause after tokens')).toBeInstanceOf(HTMLButtonElement)
      })
      getMenuItem('Pause after tokens')?.dispatchEvent(new KeyboardEvent('keydown', {bubbles: true, key: 'ArrowLeft'}))
      await waitForCondition(() => {
        expect(getMenuItem('Pause now')).toBeInstanceOf(HTMLButtonElement)
      })

      await clickMenuItem('Pause at …')
      await waitForCondition(() => {
        expect(getMenuItem('Pause at')).toBeInstanceOf(HTMLButtonElement)
      })
      getMenuItem('Pause at')?.dispatchEvent(new KeyboardEvent('keydown', {bubbles: true, key: 'Backspace'}))
      await waitForCondition(() => {
        expect(getMenuItem('Pause now')).toBeInstanceOf(HTMLButtonElement)
      })

      getMenuItem('Pause now')?.dispatchEvent(new KeyboardEvent('keydown', {bubbles: true, key: 'Escape'}))
      await waitForCondition(() => {
        expect(trigger.getAttribute('aria-expanded')).toBe('false')
      })
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
