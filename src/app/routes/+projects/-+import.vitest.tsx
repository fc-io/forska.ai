// @vitest-environment happy-dom

import type {Component, JSX, ParentProps} from 'solid-js'
import {splitProps} from 'solid-js'
import {Dynamic} from 'solid-js/web'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'

type MockLinkProps = ParentProps<{class?: string; to: string}>
type MockButtonProps = ParentProps<
  {as?: keyof JSX.IntrinsicElements | Component<Record<string, unknown>>; disabled?: boolean} & Record<string, unknown>
>

const getSession = (overrides: Record<string, unknown> = {}) => {
  return {
    analyzeUrl: '/api/projects/import/session-1/analyze',
    blockers: [],
    canCommit: false,
    cancelUrl: '/api/projects/import/session-1',
    commitId: null,
    commitUrl: '/api/projects/import/session-1/commit',
    completion: null,
    createdAt: '2030-01-01T00:00:00.000Z',
    direction: 'import',
    duplicatePackageWarnings: [],
    error: null,
    expiresAt: '2030-01-02T00:00:00.000Z',
    heartbeatAt: null,
    id: 'session-1',
    overlapCounts: null,
    ownerToken: null,
    packageFingerprint: 'fingerprint-1',
    plan: {
      blockers: [
        {
          code: 'article_conflict',
          message: 'Article conflict requires target changes',
          resolutionKind: 'requires_new_package_or_target_changes',
          scope: 'articles.source-1',
        },
      ],
      canCommit: false,
      dependencyResolution: {
        modelTargetBySourceId: {'model-source-1': 'model-target-1'},
        providerTargetBySourceId: {'provider-source-1': 'provider-target-1'},
      },
      packageCounts: {articles: 1, models: 1, providerConnections: 1},
      packageFingerprint: 'fingerprint-1',
      packageWarnings: [
        {code: 'duplicate_import', message: 'Duplicate import package fingerprint matched another project.'},
      ],
      planRevision: 2,
      resolutionKinds: {article_conflict: 'requires_new_package_or_target_changes'},
      summary: null,
      targetPlan: {
        articleRoutePlan: [
          {
            action: 'omit',
            snapshotProjectArticleLink: true,
            sourceArticleId: 'article-source-1',
            sourceImportRouteId: 'route-source-1',
            targetArticleId: 'article-target-1',
          },
        ],
        articleUpdatePlan: [
          {
            fieldFills: [{field: 'fullText', value: 'text'}],
            sourceArticleId: 'article-source-1',
            targetArticleId: 'article-target-1',
          },
        ],
        humanReviewPlan: [
          {
            action: 'insert',
            inputSignatureMatches: true,
            kind: 'review',
            provenanceKind: 'storedSignature',
            sourceId: 'review-source-1',
          },
        ],
        judgmentPlan: [
          {
            action: 'reuse',
            inputSignatureMatches: true,
            provenanceKind: 'snapshotVerified',
            sourceJudgmentId: 'judgment-source-1',
          },
        ],
        projectRoutePlan: [
          {action: 'omit', sourceImportRouteId: 'route-source-1', sourceProjectImportRouteId: 'project-route-source-1'},
        ],
      },
    },
    planRevision: 2,
    planSummary: {
      blockerCount: 1,
      blockers: [
        {
          code: 'article_conflict',
          message: 'Article conflict requires target changes',
          resolutionKind: 'requires_new_package_or_target_changes',
          scope: 'articles.source-1',
        },
      ],
      conflictCounts: {
        articleConflictCount: 1,
        humanReviewFidelityConflictCount: 0,
        judgmentConflictCount: 0,
        packageContractConflictCount: 0,
        projectPromptConflictCount: 0,
      },
      dependencyStatuses: {'model:model-source-1': 'resolved', 'provider:provider-source-1': 'resolved'},
      judgmentConflictStatus: 'clear',
      overlapCounts: {
        currentReviewRowsSignatureHumanReviewCount: 0,
        currentReviewRowsSignatureJudgmentCount: 0,
        dirtiedExistingProjectCount: 1,
        duplicateImportMatchCount: 1,
        newArticleCount: 0,
        omittedArticleRouteLinkCount: 1,
        omittedRouteLinkCount: 1,
        reusedArticleAssetPromotionCount: 0,
        reusedArticleCount: 1,
        reusedArticleFieldFillCount: 1,
        reusedArticleUpdateCount: 1,
        reusedJudgmentCount: 1,
        routeArticleSnapshotLinkCount: 1,
        snapshotVerifiedJudgmentCount: 1,
        storedSignatureHumanReviewCount: 1,
        storedSignatureJudgmentCount: 0,
      },
      packageCounts: {articles: 1, models: 1, providerConnections: 1},
      packageFingerprint: 'fingerprint-1',
      packageWarnings: [
        {code: 'duplicate_import', message: 'Duplicate import package fingerprint matched another project.'},
      ],
      warningCount: 1,
    },
    progress: {percent: 100, phase: 'analyze', status: 'completed'},
    resolveDependenciesUrl: '/api/projects/import/session-1/resolve-dependencies',
    sessionUrl: '/api/projects/import/session-1',
    state: 'awaiting_resolution',
    updatedAt: '2030-01-01T00:00:00.000Z',
    upload: {byteLength: 1024, checksumSha256: 'a'.repeat(64), fileName: 'package.zip'},
    uploadUrl: '/api/projects/import/session-1/upload',
    warnings: ['Duplicate import package fingerprint matched another project.'],
    ...overrides,
  }
}

const mockState = vi.hoisted(() => {
  return {
    analyzeInputs: [] as unknown[],
    commitInputs: [] as unknown[],
    commitResult: null as Record<string, unknown> | null,
    createInputs: [] as unknown[],
    codexStatusQueryResult: {
      data: {
        appServerReady: false,
        cli: {loggedIn: false, method: null, ok: true, raw: ''},
        codexBin: 'codex',
        message: 'Login required',
      },
      error: null,
      isError: false,
      isFetching: false,
      isLoading: false,
      refetch: vi.fn(),
    },
    manualProviderModelInputs: [] as unknown[],
    providerConnectionsQueryResult: {
      data: {
        catalog: [
          {
            defaultBaseURL: null,
            description: '',
            kind: 'openai-compatible',
            label: 'OpenAI Compatible',
            requiresApiKey: true,
            supportsDiscovery: true,
            supportsWorkerUrls: false,
          },
        ],
        connections: [
          {
            authMode: 'api-key',
            baseURL: 'https://example.com',
            config: {manualWorkerUrls: [], workerUrlMode: 'manual'},
            createdAt: null,
            effectiveMaxInflightRequests: 1,
            enabled: true,
            hasSecret: true,
            id: 'provider-target-1',
            label: 'Target Provider',
            lastCheckedAt: null,
            lastError: null,
            maxInflightRequests: null,
            models: [
              {
                baseURL: null,
                createdAt: null,
                displayName: 'Target Model',
                enabled: true,
                id: 'model-target-1',
                metadataJson: {},
                modelName: 'target-model',
                name: 'Target Model',
                provider: 'openai-compatible',
                providerConnectionId: 'provider-target-1',
                remoteModelId: 'target-model',
                source: 'manual',
                updatedAt: null,
                variant: null,
                version: null,
              },
            ],
            providerKind: 'openai-compatible',
            updatedAt: null,
            workerState: {
              effectiveWorkerUrls: [],
              match: {},
              resolutionMode: 'manual',
              runtimeWorkerUrls: [],
              workerSource: 'none',
            },
          },
        ],
        runtime: {activeModelNames: [], providerKind: null, sourceMetadata: null, workerUrls: []},
      },
      error: null,
      isError: false,
      isFetching: false,
      isLoading: false,
      refetch: vi.fn(),
    },
    queryClient: {setQueryData: vi.fn()},
    resolveInputs: [] as unknown[],
    sessionQueryResult: {
      data: null,
      error: null,
      isError: false,
      isFetching: false,
      isLoading: false,
      refetch: vi.fn(),
    },
    navigate: vi.fn(),
    uploadInputs: [] as unknown[],
  }
})

vi.mock('@tanstack/solid-query', () => {
  return {
    createMutation: (
      factory: () => {mutationFn?: (input?: unknown) => unknown; onSuccess?: (value: unknown) => void},
    ) => {
      const options = factory()

      return {
        error: null,
        isError: false,
        isPending: false,
        mutate: vi.fn((input?: unknown) => {
          const result = options.mutationFn?.(input)
          void Promise.resolve(result).then((value) => {
            options.onSuccess?.(value)
          })
          return result
        }),
        mutateAsync: vi.fn(async (input?: unknown) => {
          return options.mutationFn?.(input)
        }),
      }
    },
    useQuery: (options: () => {queryKey: readonly unknown[]}) => {
      const key = options().queryKey[0]

      if (key === 'provider-connections') {
        return mockState.providerConnectionsQueryResult
      }
      if (key === 'codex-status') {
        return mockState.codexStatusQueryResult
      }
      return mockState.sessionQueryResult
    },
    useQueryClient: () => {
      return mockState.queryClient
    },
  }
})

vi.mock('../+admin/+models/providerConnectionsClient.ts', () => {
  return {
    addManualProviderModel: vi.fn((input: unknown) => {
      mockState.manualProviderModelInputs.push(input)

      return Promise.resolve({modelId: 'materialized-model-1'})
    }),
    beginProviderAuthLifecycle: vi.fn(() => {
      return {message: 'auth started', status: 'started'}
    }),
    createProviderConnection: vi.fn(() => {
      return mockState.providerConnectionsQueryResult.data.connections[0]
    }),
    fetchCodexStatus: vi.fn(),
    fetchProviderConnectionDiscoveredModels: vi.fn(() => {
      return []
    }),
    fetchProviderConnections: vi.fn(),
    finishProviderAuthLifecycle: vi.fn(() => {
      return {message: 'auth finished', status: 'finished'}
    }),
    startCodexLogin: vi.fn(() => {
      return {message: 'login started'}
    }),
    syncProviderConnectionModels: vi.fn(() => {
      return {count: 0}
    }),
    testProviderConnectionApi: vi.fn(() => {
      return {message: 'connection ok', status: 'ok'}
    }),
  }
})

vi.mock('./importWizard/projectImportClient.ts', () => {
  return {
    analyzeProjectImportSession: vi.fn((input: unknown) => {
      mockState.analyzeInputs.push(input)
      return {...getSession({state: 'awaiting_resolution'}), ...(input as Record<string, unknown>)}
    }),
    cancelProjectImportSession: vi.fn(() => {
      return getSession({state: 'cancelled'})
    }),
    commitProjectImportSession: vi.fn((input: unknown) => {
      mockState.commitInputs.push(input)
      return mockState.commitResult ?? getSession({canCommit: false, state: 'committing'})
    }),
    createProjectImportSession: vi.fn(() => {
      mockState.createInputs.push(null)
      return getSession({state: 'awaiting_upload'})
    }),
    fetchProjectImportSession: vi.fn(() => {
      return getSession()
    }),
    projectImportSessionQueryKey: (sessionId: string | null) => {
      return ['project-import-session', sessionId ?? 'none'] as const
    },
    resolveProjectImportDependencies: vi.fn((input: unknown) => {
      mockState.resolveInputs.push(input)

      return getSession({stalePlan: false})
    }),
    uploadProjectImportPackage: vi.fn((input: unknown) => {
      const uploadInput = input as {onProgress?: (percent: number) => void}

      mockState.uploadInputs.push(input)
      uploadInput.onProgress?.(100)

      return getSession({state: 'queued'})
    }),
  }
})

vi.mock('@tanstack/solid-router', () => {
  return {
    Link: (props: MockLinkProps) => {
      return (
        <a class={props.class} href={props.to}>
          {props.children}
        </a>
      )
    },
    createFileRoute: () => {
      return () => {
        return {}
      }
    },
    useNavigate: () => {
      return mockState.navigate
    },
  }
})

vi.mock('../../../components/ui/button', () => {
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

const renderImportWizard = async () => {
  const {render} = await import('solid-js/web')
  const {ImportProjectWizard} = await import('./importWizard/importProjectWizard.tsx')

  const container = document.createElement('div')
  document.body.appendChild(container)
  const dispose = render(() => {
    return <ImportProjectWizard />
  }, container)

  await Promise.resolve()

  return {container, dispose}
}

const flushMutationUpdates = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

describe('project import route', () => {
  beforeEach(() => {
    vi.resetModules()
    document.body.innerHTML = ''
    window.history.replaceState(null, '', '/projects/import?sessionId=session-1')
    mockState.analyzeInputs = []
    mockState.commitInputs = []
    mockState.commitResult = null
    mockState.createInputs = []
    mockState.manualProviderModelInputs = []
    mockState.resolveInputs = []
    mockState.uploadInputs = []
    mockState.navigate.mockClear()
    mockState.queryClient.setQueryData.mockClear()
    mockState.sessionQueryResult = {
      data: getSession(),
      error: null,
      isError: false,
      isFetching: false,
      isLoading: false,
      refetch: vi.fn(),
    }
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  test('renders the wizard shell and full plan review surfaces', async () => {
    const {container, dispose} = await renderImportWizard()

    try {
      const debugSection = Array.from(container.querySelectorAll('details')).find((details) => {
        return details.querySelector('summary')?.textContent?.includes('Debug')
      })

      expect(container.textContent).toContain('Import Project')
      expect(container.textContent).toContain('Upload a transfer package')
      expect(container.textContent).toContain('Debug')
      expect(debugSection?.textContent).toContain('Package review')
      expect(debugSection?.textContent).toContain('Overlap summary')
      expect(debugSection?.textContent).toContain('Conflict summary')
      expect(debugSection?.textContent).toContain('Dependency status')
      expect(debugSection?.textContent).toContain('Session')
      expect(debugSection?.textContent).toContain('Read paths')
      expect(container.textContent).toContain('Reused-article update plan')
      expect(container.textContent).toContain('Route-link omissions')
      expect(container.textContent).toContain('Snapshot project-article links')
      expect(container.textContent).toContain('Final provider mappings')
      expect(container.textContent).toContain('Final model mappings')
      expect(container.textContent).toContain('Judgment comparison signature source')
      expect(container.textContent).toContain('Human/review comparison signature source')
      expect(container.textContent).toContain('Shows where the judgment comparison signature came from')
      expect(container.textContent).not.toContain('Dependency resolution')
      expect(container.textContent).not.toContain('Start import review')
      expect(container.textContent).toContain('requires new package or target changes')
      expect(container.textContent).toContain('Create project from import')
      expect((container.textContent ?? '').indexOf('Create project from import')).toBeLessThan(
        (container.textContent ?? '').indexOf('Import progress'),
      )
      expect(debugSection?.hasAttribute('open')).toBe(false)
    } finally {
      dispose()
      container.remove()
    }
  })

  test('starts import automatically when a package is selected', async () => {
    const {container, dispose} = await renderImportWizard()

    try {
      const input = container.querySelector('input[type="file"]')
      const file = new File(['project-transfer'], 'project-transfer.zip', {type: 'application/zip'})

      expect(input).not.toBeNull()
      Object.defineProperty(input, 'files', {configurable: true, value: [file]})
      input?.dispatchEvent(new Event('change', {bubbles: true}))
      await flushMutationUpdates()

      expect(container.textContent).not.toContain('Start import review')
      expect(mockState.createInputs).toEqual([null])
      expect(mockState.uploadInputs).toMatchObject([{file, sessionId: 'session-1'}])
      expect(mockState.analyzeInputs).toEqual([{expectedPlanRevision: 2, sessionId: 'session-1'}])
    } finally {
      dispose()
      container.remove()
    }
  })

  test('keeps the wizard shell rendered during extract and analyze progress', async () => {
    mockState.sessionQueryResult = {
      ...mockState.sessionQueryResult,
      data: getSession({progress: {percent: 35, phase: 'extract', status: 'running'}, state: 'extracting'}),
    }

    const {container, dispose} = await renderImportWizard()

    try {
      expect(container.textContent).toContain('Import Project')
      expect(container.textContent).toContain('Import progress')
      expect(container.textContent).toContain('Extract')
      expect(container.textContent).toContain('Package review')
    } finally {
      dispose()
      container.remove()
    }
  })

  test('groups repeated package warnings by message', async () => {
    mockState.sessionQueryResult = {
      ...mockState.sessionQueryResult,
      data: getSession({
        planSummary: {
          ...getSession().planSummary,
          packageWarnings: [
            {code: 'payloadOmitted', message: 'Dependent payload row was omitted because its parent row was omitted.'},
            {code: 'payloadOmitted', message: 'Dependent payload row was omitted because its parent row was omitted.'},
            {
              code: 'urlRedacted',
              message: 'URL credentials, query, or fragment were redacted from the package payload.',
            },
            {
              code: 'urlRedacted',
              message: 'URL credentials, query, or fragment were redacted from the package payload.',
            },
          ],
        },
      }),
    }

    const {container, dispose} = await renderImportWizard()

    try {
      expect(container.textContent).toContain(
        'Dependent payload row was omitted because its parent row was omitted. (x2)',
      )
      expect(container.textContent).toContain(
        'URL credentials, query, or fragment were redacted from the package payload. (x2)',
      )
    } finally {
      dispose()
      container.remove()
    }
  })

  test('renders omission warning context and keeps distinct rows distinguishable', async () => {
    const decisionMessage = 'Payload row was omitted by export policy.'
    const dependentMessage = 'Dependent payload row was omitted because its parent row was omitted.'

    mockState.sessionQueryResult = {
      ...mockState.sessionQueryResult,
      data: getSession({
        planSummary: {
          ...getSession().planSummary,
          packageWarnings: [
            {
              code: 'payloadOmitted',
              details: {reason: 'runtimePathRedacted', sourceRowId: 'article-1', triggeringField: 'articleTitle'},
              message: decisionMessage,
            },
            {
              code: 'payloadOmitted',
              details: {reason: 'runtimePathRedacted', sourceRowId: 'article-1', triggeringField: 'articleTitle'},
              message: decisionMessage,
            },
            {
              code: 'payloadOmitted',
              details: {reason: 'providerSecretRedacted', sourceRowId: 'article-2', triggeringField: 'abstract'},
              message: decisionMessage,
            },
            {
              code: 'route_omitted',
              details: {dependencyReason: 'sourceArticle', omittedParentRef: 'article-1', reason: 'sourceArticle'},
              message: dependentMessage,
            },
          ],
        },
      }),
    }

    const {container, dispose} = await renderImportWizard()

    try {
      const warningItems = Array.from(container.querySelectorAll('li')).map((item) => {
        return item.textContent ?? ''
      })
      const decisionWarningItems = warningItems.filter((item) => {
        return item.includes(decisionMessage)
      })

      expect(decisionWarningItems).toHaveLength(2)
      expect(decisionWarningItems[0]).toContain('(x2)')
      expect(decisionWarningItems[0]).toContain('Source row')
      expect(decisionWarningItems[0]).toContain('article-1')
      expect(decisionWarningItems[0]).toContain('Field')
      expect(decisionWarningItems[0]).toContain('articleTitle')
      expect(decisionWarningItems[1]).toContain('article-2')
      expect(decisionWarningItems[1]).toContain('abstract')
      expect(container.textContent).toContain('Dependency reason')
      expect(container.textContent).toContain('sourceArticle')
      expect(container.textContent).toContain('Omitted parent')
    } finally {
      dispose()
      container.remove()
    }
  })

  test('commits a ready plan, shows post-import warnings, and navigates to imported project', async () => {
    const completion = {
      importWarnings: [{code: 'route_omitted', message: 'One route link was omitted.'}],
      packageFingerprint: 'fingerprint-1',
      projectId: 'target-project-1',
      projectName: 'Imported Project',
      status: 'completed',
      targetProjectId: 'target-project-1',
      targetProjectName: 'Imported Project',
      transferHistoryId: 'history-1',
    }
    mockState.sessionQueryResult = {
      ...mockState.sessionQueryResult,
      data: getSession({canCommit: true, state: 'ready_to_commit'}),
    }
    mockState.commitResult = getSession({
      canCommit: false,
      completion,
      state: 'completed',
      updatedAt: '2030-01-01T00:00:01.000Z',
    })

    const {container, dispose} = await renderImportWizard()

    try {
      const commitButton = Array.from(container.querySelectorAll('button')).find((button) => {
        return button.textContent?.includes('Create project from import')
      })

      commitButton?.click()
      await flushMutationUpdates()

      expect(mockState.commitInputs).toEqual([{planRevision: 2, sessionId: 'session-1'}])
      expect(container.textContent).toContain('Post-import warnings')
      expect(container.textContent).toContain('One route link was omitted.')
      expect(mockState.navigate).toHaveBeenCalledWith({params: {id: 'target-project-1'}, to: '/projects/$id'})
    } finally {
      dispose()
      container.remove()
    }
  })

  test('updates the session query cache when a background commit starts', async () => {
    const committingSession = getSession({
      canCommit: false,
      progress: {phase: 'revalidation', status: 'running'},
      state: 'committing',
      updatedAt: '2030-01-01T00:00:01.000Z',
    })
    mockState.sessionQueryResult = {
      ...mockState.sessionQueryResult,
      data: getSession({canCommit: true, state: 'ready_to_commit'}),
    }
    mockState.commitResult = committingSession

    const {container, dispose} = await renderImportWizard()

    try {
      const commitButton = Array.from(container.querySelectorAll('button')).find((button) => {
        return button.textContent?.includes('Create project from import')
      })

      commitButton?.click()
      await flushMutationUpdates()

      expect(mockState.queryClient.setQueryData).toHaveBeenCalledWith(
        ['project-import-session', 'session-1'],
        committingSession,
      )
      expect(container.textContent).toContain('Create progress')
      expect(container.textContent).toContain('Working on revalidation.')
      expect(container.textContent).not.toContain('Commit started. Progress will update here.')
    } finally {
      dispose()
      container.remove()
    }
  })

  test('shows indeterminate create progress instead of stale upload percent', async () => {
    const readyPlanSummary = {
      ...getSession().planSummary,
      blockerCount: 0,
      blockers: [],
      conflictCounts: {...getSession().planSummary.conflictCounts, articleConflictCount: 0},
    }
    mockState.sessionQueryResult = {
      ...mockState.sessionQueryResult,
      data: getSession({blockers: [], canCommit: true, planSummary: readyPlanSummary, state: 'ready_to_commit'}),
    }
    mockState.commitResult = getSession({
      blockers: [],
      canCommit: false,
      progress: {phase: 'revalidation', status: 'running'},
      planSummary: readyPlanSummary,
      state: 'committing',
      updatedAt: '2030-01-01T00:00:01.000Z',
    })

    const {container, dispose} = await renderImportWizard()

    try {
      const input = container.querySelector('input[type="file"]')
      const file = new File(['project-transfer'], 'project-transfer.zip', {type: 'application/zip'})

      Object.defineProperty(input, 'files', {configurable: true, value: [file]})
      input?.dispatchEvent(new Event('change', {bubbles: true}))
      await flushMutationUpdates()
      await flushMutationUpdates()

      const commitButton = Array.from(container.querySelectorAll('button')).find((button) => {
        return button.textContent?.includes('Create project from import')
      })

      expect(container.textContent).toContain('Plan ready')
      expect(commitButton?.disabled).toBe(false)

      commitButton?.click()
      await flushMutationUpdates()

      expect(mockState.uploadInputs).toHaveLength(1)
      expect(mockState.commitInputs).toEqual([{planRevision: 2, sessionId: 'session-1'}])
      expect(container.textContent).toContain('Create progress')
      expect(container.textContent).toContain('Working on revalidation.')
      expect(container.textContent).not.toContain('100%')
    } finally {
      dispose()
      container.remove()
    }
  })

  test('shows elapsed and item details for create progress', async () => {
    mockState.sessionQueryResult = {
      ...mockState.sessionQueryResult,
      data: getSession({
        progress: {
          bytesProcessed: 0,
          bytesTotal: 0,
          completedItems: 2,
          message: 'Loading package payload judgments',
          percent: 0,
          phase: 'staging_load',
          startedAt: '2026-05-28T10:00:00.000Z',
          status: 'running',
          totalItems: 15,
          updatedAt: '2030-01-01T00:00:01.000Z',
        },
        state: 'committing',
        updatedAt: '2030-01-01T00:00:01.000Z',
      }),
    }

    const {container, dispose} = await renderImportWizard()

    try {
      expect(container.textContent).toContain('Create progress')
      expect(container.textContent).toContain('0% · Loading package payload judgments')
      expect(container.textContent).toContain('Activity: Loading package payload judgments')
      expect(container.textContent).toContain('Elapsed:')
      expect(container.textContent).toContain('Items: 2 of 15')
      expect(container.textContent).not.toContain('Bytes: 0 B of 0 B')
    } finally {
      dispose()
      container.remove()
    }
  })

  test('stops elapsed timer when import progress is completed', async () => {
    mockState.sessionQueryResult = {
      ...mockState.sessionQueryResult,
      data: getSession({
        progress: {
          message: 'Analysis completed',
          percent: 100,
          phase: 'analyze',
          startedAt: '2030-01-01T00:00:00.000Z',
          status: 'completed',
          updatedAt: '2030-01-01T00:03:05.000Z',
        },
        state: 'ready_to_commit',
        updatedAt: '2030-01-01T00:03:05.000Z',
      }),
    }

    const {container, dispose} = await renderImportWizard()

    try {
      expect(container.textContent).toContain('Import progress')
      expect(container.textContent).toContain('Elapsed: 3m 5s')
      expect(container.textContent).not.toContain('Progress update:')
      expect(container.textContent).not.toContain('Session heartbeat:')
    } finally {
      dispose()
      container.remove()
    }
  })

  test('does not expose manual provider or model remapping controls', async () => {
    mockState.sessionQueryResult = {
      ...mockState.sessionQueryResult,
      data: getSession({
        planSummary: {
          ...getSession().planSummary,
          dependencyStatuses: {'model:model-source-1': 'missing', 'provider:provider-source-1': 'missing'},
        },
      }),
    }

    const {container, dispose} = await renderImportWizard()

    try {
      expect(container.textContent).toContain('Provider and model dependencies resolve to imported source snapshots.')
      expect(container.textContent).not.toContain('Existing enabled target connection')
      expect(container.textContent).not.toContain('Existing enabled target model')
      expect(container.textContent).not.toContain('Materialize model')
      expect(mockState.manualProviderModelInputs).toEqual([])
    } finally {
      dispose()
      container.remove()
    }
  })

  test('manually auto-resolves unresolved dependencies when the analyzed session is awaiting resolution', async () => {
    mockState.sessionQueryResult = {
      ...mockState.sessionQueryResult,
      data: getSession({
        planSummary: {
          ...getSession().planSummary,
          dependencyStatuses: {'model:model-source-1': 'missing', 'provider:provider-source-1': 'missing'},
        },
      }),
    }

    const {container, dispose} = await renderImportWizard()

    try {
      const autoResolveButton = Array.from(container.querySelectorAll('button')).find((button) => {
        return button.textContent?.includes('Auto-resolve')
      })

      autoResolveButton?.click()
      await Promise.resolve()

      expect(mockState.resolveInputs[0]).toEqual({autoResolve: true, planRevision: 2, sessionId: 'session-1'})
      expect(container.textContent).toContain('Dependency plan updated.')
    } finally {
      dispose()
      container.remove()
    }
  })

  test('shows stale plan handling and keeps final commit disabled', async () => {
    mockState.sessionQueryResult = {
      ...mockState.sessionQueryResult,
      data: getSession({canCommit: true, stalePlan: true, state: 'ready_to_commit'}),
    }

    const {container, dispose} = await renderImportWizard()

    try {
      const commitButton = Array.from(container.querySelectorAll('button')).find((button) => {
        return button.textContent?.includes('Create project from import')
      })

      expect(container.textContent).toContain('Plan revision changed')
      expect(container.textContent).toContain('Review the refreshed plan before committing.')
      expect(commitButton?.hasAttribute('disabled')).toBe(true)
    } finally {
      dispose()
      container.remove()
    }
  })
})
