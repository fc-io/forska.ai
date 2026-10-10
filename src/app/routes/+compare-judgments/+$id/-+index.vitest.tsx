// @vitest-environment happy-dom

import {QueryClient, QueryClientProvider} from '@tanstack/solid-query'
import type {Component, JSX, ParentProps} from 'solid-js'
import {lazy, splitProps} from 'solid-js'
import {Dynamic, render} from 'solid-js/web'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'

import type {
  ComparisonJudgmentContextSummary,
  ComparisonProjectJudgmentsMetadata,
  ComparisonProjectJudgmentsRow,
  ComparisonProjectStats,
} from '../../../../services/comparisonProjectsService.ts'

type MockButtonProps = ParentProps<
  {as?: keyof JSX.IntrinsicElements | Component<Record<string, unknown>>} & Record<string, unknown>
>

const mockState = vi.hoisted(() => {
  return {
    fetchComparisonJudgmentContexts: vi.fn(),
    fetchComparisonProjectJudgmentsCount: vi.fn(),
    fetchComparisonProjectJudgmentsMetadata: vi.fn(),
    fetchComparisonProjectJudgmentsPage: vi.fn(),
    fetchComparisonProjectStats: vi.fn(),
    navigate: vi.fn((_options: {search: Record<string, string>}) => {
      return Promise.resolve()
    }),
    search: {} as Record<string, unknown>,
  }
})

vi.mock('@tanstack/solid-router', () => {
  return {
    lazyRouteComponent: (importer: () => Promise<Record<string, Component>>, exportName = 'component') => {
      return lazy(async () => {
        const routeModule = await importer()

        return {default: routeModule[exportName] as Component}
      })
    },
    Link: (props: ParentProps<{class?: string; to: string}>) => {
      return (
        <a class={props.class} href={props.to}>
          {props.children}
        </a>
      )
    },
    createFileRoute: () => {
      return (config: Record<string, unknown>) => {
        return {
          ...config,
          useParams: () => {
            return () => {
              return {id: 'comparison-project-1'}
            }
          },
          useSearch: () => {
            return () => {
              return mockState.search
            }
          },
        }
      }
    },
    useNavigate: () => {
      return mockState.navigate
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

vi.mock('../../../../services/comparisonProjectsService.ts', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()

  return {
    ...original,
    fetchComparisonJudgmentContexts: mockState.fetchComparisonJudgmentContexts,
    fetchComparisonProjectJudgmentsCount: mockState.fetchComparisonProjectJudgmentsCount,
    fetchComparisonProjectJudgmentsMetadata: mockState.fetchComparisonProjectJudgmentsMetadata,
    fetchComparisonProjectJudgmentsPage: mockState.fetchComparisonProjectJudgmentsPage,
    fetchComparisonProjectStats: mockState.fetchComparisonProjectStats,
  }
})

const getContextSummary = (id: string): ComparisonJudgmentContextSummary => {
  return {
    context: {columns: [], humanJudgmentMode: 'summary', sourceProjectIds: [], summarySourceProjectId: null, v: 1},
    createdAt: null,
    id,
    modelIds: [],
    models: [],
    promptIds: [],
    prompts: [],
    systemPromptVariants: [],
  }
}

const getMetadata = (activeGeneration: number, judgmentContextId: string): ComparisonProjectJudgmentsMetadata => {
  return {
    activeGeneration,
    allowConflictResolution: true,
    archived: false,
    columns: [
      {
        contentLabel: null,
        id: 'human:summary',
        kind: 'human',
        modelId: null,
        modelLabel: 'Human',
        promptId: 'summary',
        promptLabel: 'Summary',
        sourceProjectId: null,
        sourceProjectName: null,
      },
      {
        contentLabel: null,
        id: 'llm:model-1:summary',
        kind: 'llm',
        modelId: 'model-1',
        modelLabel: 'GPT-5.5',
        promptId: 'summary',
        promptLabel: 'Summary',
        sourceProjectId: null,
        sourceProjectName: null,
      },
    ],
    compareWithHumans: true,
    contentVariants: [],
    createdAt: '2026-10-01T00:00:00.000Z',
    description: null,
    humanJudgmentMode: 'summary',
    id: 'comparison-project-1',
    importRouteIds: [],
    isServingReady: true,
    judgmentContext: getContextSummary(judgmentContextId),
    judgmentContextId,
    models: [],
    name: 'Compare project',
    prompts: [
      {
        criteriaDisposition: null,
        criteriaSectionKey: null,
        criteriaSectionLabel: null,
        id: 'prompt-1',
        order: 0,
        promptHeading: 'Population',
        promptLabel: 'Population',
        type: "'yes' | 'no' | 'maybe'",
      },
    ],
    resolutionCount: 2,
    servingProgress: {
      completedAt: null,
      failedAt: null,
      generation: activeGeneration,
      lastError: null,
      lastProgressedAt: null,
      phase: 'ready',
      phaseStartedAt: null,
      stagedArticleCount: 0,
      stagedCellCount: 0,
      stagedFilterMemberCount: 0,
      stagedFilterStatsCount: 0,
      startedAt: null,
      totalArticleCount: null,
      totalCellCount: null,
    } as ComparisonProjectJudgmentsMetadata['servingProgress'],
    servingStatus: 'ready',
    servingUpdatedAt: null,
    sourceProjects: [],
    summarySourceProject: null,
    summarySourceProjectId: null,
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  }
}

const getRow = (articleId: string, contextId: string): ComparisonProjectJudgmentsRow => {
  return {
    articleCreatedAt: null,
    articleExternalId: null,
    articleSummary: null,
    articleTitle: articleId,
    canonicalArticleId: articleId,
    cells: {'human:summary': 'yes', 'llm:model-1:summary': 'no'},
    conflictResolution: {
      articleId,
      label: 'yes',
      provenance: {contextId, generation: 1, origin: 'ui', setAt: '2026-10-10T10:00:00.000Z'},
      provenanceMatchesCurrent: contextId === 'context-current',
      reviewer: {displayName: 'Fredrik', userId: 'local-1'},
      reviewerDisplayName: 'Fredrik',
      reviewerUserId: 'local-1',
      setAt: '2026-10-10T10:00:00.000Z',
      value: 'yes',
    },
    hasConflict: true,
    id: articleId,
  }
}

const getStats = (conflictResolutionProvenance: 'all' | 'current'): ComparisonProjectStats => {
  return {
    activeGeneration: 1,
    additionalProjectStats: {conflictResolutionAnswerComparisons: [], resolvedTruthComparisons: []},
    categoryBreakdowns: [],
    comparisons: [],
    conflictResolutionProvenance,
    conflictResolutionProvenanceScope: {applied: true, reason: null, requested: conflictResolutionProvenance},
    isServingReady: true,
    judgmentContextId: 'context-current',
    servingStatus: 'ready',
    servingUpdatedAt: null,
  }
}

const tick = () => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

const waitForCondition = async (assertion: () => void, remaining = 50): Promise<void> => {
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

const renderComparePage = async () => {
  const {Route} = await import('./+index.tsx')
  const PageComponent = (Route as unknown as {component: Component & {preload: () => Promise<unknown>}}).component
  await PageComponent.preload()
  const queryClient = new QueryClient({defaultOptions: {queries: {retry: false}}})
  const container = document.createElement('div')
  document.body.appendChild(container)
  const dispose = render(() => {
    return (
      <QueryClientProvider client={queryClient}>
        <PageComponent />
      </QueryClientProvider>
    )
  }, container)

  return {container, dispose, queryClient}
}

describe('Compare project judgments page', () => {
  beforeEach(() => {
    mockState.search = {conflictResolutionFilter: 'yes', conflictResolutionProvenanceFilter: 'outdated'}
    mockState.fetchComparisonProjectJudgmentsMetadata.mockImplementation(async () => {
      return getMetadata(1, 'context-current')
    })
    mockState.fetchComparisonProjectJudgmentsPage.mockImplementation(async () => {
      return {
        activeGeneration: 1,
        data: [getRow('article-current', 'context-current'), getRow('article-older', 'context-older')],
        isServingReady: true,
        limit: 50,
        nextCursor: null,
        page: 1,
        servingStatus: 'ready',
        servingUpdatedAt: null,
        totalCount: null,
        totalPages: null,
      }
    })
    mockState.fetchComparisonProjectJudgmentsCount.mockImplementation(async () => {
      return {
        activeGeneration: 1,
        isServingReady: true,
        limit: 50,
        servingStatus: 'ready',
        servingUpdatedAt: null,
        totalCount: 2,
        totalPages: 1,
      }
    })
    mockState.fetchComparisonProjectStats.mockImplementation(async (_id: string, scope: 'all' | 'current') => {
      return getStats(scope)
    })
    mockState.fetchComparisonJudgmentContexts.mockImplementation(async (ids: string[]) => {
      return ids.map(getContextSummary)
    })
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  test('sends the URL resolution filters with the page and count requests and restores them in the URL', async () => {
    const {dispose, queryClient} = await renderComparePage()

    try {
      await waitForCondition(() => {
        expect(mockState.fetchComparisonProjectJudgmentsCount).toHaveBeenCalled()
      })

      expect(mockState.fetchComparisonProjectJudgmentsPage.mock.calls[0]?.slice(1)).toEqual([
        50,
        [],
        [],
        [],
        ['yes'],
        '',
        null,
        ['outdated'],
      ])
      expect(mockState.fetchComparisonProjectJudgmentsCount.mock.calls[0]?.slice(1)).toEqual([
        50,
        [],
        [],
        [],
        ['yes'],
        '',
        ['outdated'],
      ])
      expect(mockState.navigate.mock.calls[0]?.[0].search).toEqual({})
      expect(mockState.navigate.mock.calls.at(-1)?.[0].search).toEqual({
        conflictResolutionFilter: 'yes',
        conflictResolutionProvenanceFilter: 'outdated',
      })
    } finally {
      dispose()
      queryClient.clear()
    }
  })

  test('sends the current-prompts stats scope when the checkbox is checked', async () => {
    const {container, dispose, queryClient} = await renderComparePage()

    try {
      await waitForCondition(() => {
        expect(container.querySelector('input[type="checkbox"]')).not.toBeNull()
      })

      expect(mockState.fetchComparisonProjectStats).toHaveBeenLastCalledWith('comparison-project-1', 'all')

      container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click()

      await waitForCondition(() => {
        expect(mockState.fetchComparisonProjectStats).toHaveBeenLastCalledWith('comparison-project-1', 'current')
      })
    } finally {
      dispose()
      queryClient.clear()
    }
  })

  test('looks up only non-current contexts and refreshes rows when the active context changes', async () => {
    const {dispose, queryClient} = await renderComparePage()

    try {
      await waitForCondition(() => {
        expect(mockState.fetchComparisonJudgmentContexts).toHaveBeenCalledWith(['context-older'])
      })

      const pageCallCount = mockState.fetchComparisonProjectJudgmentsPage.mock.calls.length
      const countCallCount = mockState.fetchComparisonProjectJudgmentsCount.mock.calls.length

      mockState.fetchComparisonProjectJudgmentsMetadata.mockImplementation(async () => {
        return getMetadata(2, 'context-next')
      })
      await queryClient.invalidateQueries({queryKey: ['comparison-project-judgments-metadata']})

      await waitForCondition(() => {
        expect(mockState.fetchComparisonProjectJudgmentsPage.mock.calls.length).toBeGreaterThan(pageCallCount)
        expect(mockState.fetchComparisonProjectJudgmentsCount.mock.calls.length).toBeGreaterThan(countCallCount)
        expect(mockState.fetchComparisonJudgmentContexts).toHaveBeenLastCalledWith(['context-current', 'context-older'])
      })
    } finally {
      dispose()
      queryClient.clear()
    }
  })
})
