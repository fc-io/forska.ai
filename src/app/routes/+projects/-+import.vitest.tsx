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
    commitInputs: [] as unknown[],
    commitResult: null as Record<string, unknown> | null,
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
    uploadProjectImportPackage: vi.fn(() => {
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

describe('project import route', () => {
  beforeEach(() => {
    vi.resetModules()
    document.body.innerHTML = ''
    window.history.replaceState(null, '', '/projects/import?sessionId=session-1')
    mockState.commitInputs = []
    mockState.commitResult = null
    mockState.manualProviderModelInputs = []
    mockState.resolveInputs = []
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
      expect(container.textContent).toContain('Import Project')
      expect(container.textContent).toContain('Upload a transfer package')
      expect(container.textContent).toContain('Reused-article update plan')
      expect(container.textContent).toContain('Route-link omissions')
      expect(container.textContent).toContain('Snapshot project-article links')
      expect(container.textContent).toContain('Final provider mappings')
      expect(container.textContent).toContain('Final model mappings')
      expect(container.textContent).toContain('Judgment signature provenance')
      expect(container.textContent).toContain('Human/review signature provenance')
      expect(container.textContent).toContain('requires new package or target changes')
      expect(container.textContent).toContain('Commit import')
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
        return button.textContent?.includes('Commit import')
      })

      commitButton?.click()
      await Promise.resolve()

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
    const committingSession = getSession({canCommit: false, state: 'committing'})
    mockState.sessionQueryResult = {
      ...mockState.sessionQueryResult,
      data: getSession({canCommit: true, state: 'ready_to_commit'}),
    }
    mockState.commitResult = committingSession

    const {container, dispose} = await renderImportWizard()

    try {
      const commitButton = Array.from(container.querySelectorAll('button')).find((button) => {
        return button.textContent?.includes('Commit import')
      })

      commitButton?.click()
      await Promise.resolve()

      expect(mockState.queryClient.setQueryData).toHaveBeenCalledWith(
        ['project-import-session', 'session-1'],
        committingSession,
      )
      expect(container.textContent).toContain('Commit started. Progress will update here.')
    } finally {
      dispose()
      container.remove()
    }
  })

  test('materializes models with the selected provider connection', async () => {
    const secondConnection = {
      ...mockState.providerConnectionsQueryResult.data.connections[0],
      id: 'provider-target-2',
      label: 'Second Target Provider',
      models: [],
    }
    const originalConnections = mockState.providerConnectionsQueryResult.data.connections
    mockState.providerConnectionsQueryResult.data.connections = [...originalConnections, secondConnection]

    const {container, dispose} = await renderImportWizard()

    try {
      const providerSelect = Array.from(container.querySelectorAll('label'))
        .find((label) => {
          return label.textContent?.includes('Existing enabled target connection')
        })
        ?.querySelector('select')
      const remoteModelInput = container.querySelector('input[placeholder="Remote model id"]')
      const materializeButton = Array.from(container.querySelectorAll('button')).find((button) => {
        return button.textContent?.includes('Materialize model')
      })

      if (providerSelect instanceof HTMLSelectElement) {
        providerSelect.value = 'provider-target-2'
        providerSelect.dispatchEvent(new Event('change', {bubbles: true}))
      }
      if (remoteModelInput instanceof HTMLInputElement) {
        remoteModelInput.value = 'remote-model-2'
        remoteModelInput.dispatchEvent(new Event('input', {bubbles: true}))
      }

      materializeButton?.click()
      await Promise.resolve()
      await Promise.resolve()

      expect(mockState.manualProviderModelInputs[0]).toMatchObject({
        id: 'provider-target-2',
        remoteModelId: 'remote-model-2',
      })
      expect(mockState.resolveInputs[0]).toMatchObject({
        materializedModels: [
          {
            sourceModelId: 'model-source-1',
            targetModelId: 'materialized-model-1',
            targetProviderConnectionId: 'provider-target-2',
          },
        ],
        modelMaterializationRequests: [
          {
            remoteModelId: 'remote-model-2',
            sourceModelId: 'model-source-1',
            targetProviderConnectionId: 'provider-target-2',
          },
        ],
        planRevision: 2,
        sessionId: 'session-1',
      })
    } finally {
      mockState.providerConnectionsQueryResult.data.connections = originalConnections
      dispose()
      container.remove()
    }
  })

  test('auto-resolves unresolved dependencies when the analyzed session is awaiting resolution', async () => {
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
      await Promise.resolve()

      expect(mockState.resolveInputs[0]).toEqual({autoResolve: true, planRevision: 2, sessionId: 'session-1'})
      expect(mockState.providerConnectionsQueryResult.refetch).toHaveBeenCalled()
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
        return button.textContent?.includes('Commit import')
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
