import {createMutation, useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link, useNavigate} from '@tanstack/solid-router'
import {createEffect, createSignal, For, onCleanup, Show} from 'solid-js'
import {createStore} from 'solid-js/store'

import {Button} from '../../../../components/ui/button.tsx'
import {ProviderConnectionForm} from './providerConnectionForm.tsx'
import {
  beginProviderAuthLifecycle,
  type CodexDeviceLoginJob,
  type CodexStatus,
  createProviderConnection,
  fetchProviderConnections,
  finishProviderAuthLifecycle,
  getNullableTrimmedValue,
  getRuntimeWorkerUrlsForProvider,
  getTrimmedValue,
  getWorkerUrlsFromInputValue,
  type ProviderAuthLifecyclePayload,
  type ProviderAuthLifecycleResult,
  type ProviderCatalogEntry,
  supportsRuntimeWorkerUrls,
} from './providerConnectionsClient.ts'
import {getCodexOnboardingUiState} from './providerUiState.ts'

type ConnectionFormState = {
  apiKey: string
  baseURL: string
  enabled: boolean
  label: string
  manualWorkerUrls: string
  providerKind: string
  workerUrlMode: 'manual' | 'runtime'
}

type CodexAuthProviderState = Partial<CodexStatus> & {job?: CodexDeviceLoginJob | null}

const getConnectionFormState = (catalogEntry: ProviderCatalogEntry | null): ConnectionFormState => {
  return {
    apiKey: '',
    baseURL: catalogEntry?.defaultBaseURL ?? '',
    enabled: true,
    label: catalogEntry?.label ?? '',
    manualWorkerUrls: '',
    providerKind: catalogEntry?.kind ?? 'openai',
    workerUrlMode: supportsRuntimeWorkerUrls(catalogEntry?.kind) ? 'runtime' : 'manual',
  }
}

const getCodexProviderState = (value: unknown): CodexAuthProviderState | null => {
  return typeof value === 'object' && value !== null ? (value as CodexAuthProviderState) : null
}

const getAuthMessageClass = (status: ProviderAuthLifecycleResult['status'] | null | undefined) => {
  return status === 'complete'
    ? 'border-green-200 bg-green-50 text-green-800'
    : status === 'pending'
      ? 'border-amber-200 bg-amber-50 text-amber-800'
      : status === 'unsupported'
        ? 'border-red-200 bg-red-50 text-red-700'
        : 'border-gray-200 bg-gray-50 text-gray-700'
}

const AddProviderPage = () => {
  const navigate = useNavigate()
  const providerConnectionsQuery = useQuery(() => {
    return {
      queryFn: fetchProviderConnections,
      queryKey: ['provider-connections'],
      refetchOnWindowFocus: false,
      staleTime: 1000 * 30,
      suspense: false,
    }
  })
  const [connectionForm, setConnectionForm] = createStore<ConnectionFormState>(getConnectionFormState(null))
  const [pageError, setPageError] = createSignal('')
  const [providerAuth, setProviderAuth] = createSignal<ProviderAuthLifecycleResult | null>(null)
  const [authError, setAuthError] = createSignal('')
  const [isLoadingAuth, setIsLoadingAuth] = createSignal(false)
  const [isFinishingAuth, setIsFinishingAuth] = createSignal(false)

  const createConnectionMutation = createMutation(() => {
    return {
      mutationFn: createProviderConnection,
      onSuccess: () => {
        void navigate({to: '/admin/models/' as never})
      },
    }
  })

  const catalog = () => {
    return providerConnectionsQuery.data?.catalog ?? []
  }

  const connections = () => {
    return providerConnectionsQuery.data?.connections ?? []
  }

  const runtime = () => {
    return providerConnectionsQuery.data?.runtime ?? null
  }

  const activeCatalogEntry = () => {
    return (
      catalog().find((entry) => {
        return entry.kind === connectionForm.providerKind
      }) ?? null
    )
  }

  const activeRuntimeWorkerUrls = () => {
    return getRuntimeWorkerUrlsForProvider({providerKind: connectionForm.providerKind, runtime: runtime()})
  }

  const existingCodexConnection = () => {
    return (
      connections().find((connection) => {
        return connection.providerKind === 'codex'
      }) ?? null
    )
  }

  const authFields = () => {
    return providerAuth()?.payload?.fields ?? []
  }

  const apiKeyField = () => {
    return authFields().find((field) => {
      return field.name === 'apiKey'
    })
  }

  const shouldShowApiKeyField = () => {
    return Boolean(apiKeyField())
  }

  const codexProviderState = () => {
    return getCodexProviderState(providerAuth()?.payload?.providerState)
  }

  const codexLoginJob = () => {
    return codexProviderState()?.job ?? null
  }

  const shouldHideCodexConnectCard = () => {
    return getCodexOnboardingUiState({
      existingCodexConnection: existingCodexConnection(),
      providerAuth: providerAuth(),
      providerKind: connectionForm.providerKind,
    }).shouldHideConnectCard
  }

  const canCreateCodexProvider = () => {
    return getCodexOnboardingUiState({
      existingCodexConnection: existingCodexConnection(),
      providerAuth: providerAuth(),
      providerKind: connectionForm.providerKind,
    }).canCreateProvider
  }

  const selectCatalogEntry = (entry: ProviderCatalogEntry) => {
    setPageError('')
    setAuthError('')
    setProviderAuth(null)
    setConnectionForm(getConnectionFormState(entry))
  }

  const loadProviderAuth = async () => {
    setAuthError('')
    setIsLoadingAuth(true)

    try {
      const result = await beginProviderAuthLifecycle({providerKind: connectionForm.providerKind})
      setProviderAuth(result)
    } catch (error) {
      setProviderAuth(null)
      setAuthError(error instanceof Error ? error.message : 'Failed to load provider auth state')
    } finally {
      setIsLoadingAuth(false)
    }
  }

  const finishProviderAuthStep = async ({
    payload,
    silent,
  }: {
    payload: ProviderAuthLifecyclePayload | null
    silent?: boolean
  }) => {
    if (!silent) {
      setAuthError('')
      setIsFinishingAuth(true)
    }

    try {
      const result = await finishProviderAuthLifecycle({payload, providerKind: connectionForm.providerKind})
      setProviderAuth(result)
      return result
    } catch (error) {
      if (!silent) {
        setAuthError(error instanceof Error ? error.message : 'Failed to finish provider auth')
      }
      throw error
    } finally {
      if (!silent) {
        setIsFinishingAuth(false)
      }
    }
  }

  createEffect(() => {
    const firstEntry = catalog()[0] ?? null

    if (!firstEntry) {
      return
    }

    if (
      !catalog().some((entry) => {
        return entry.kind === connectionForm.providerKind
      })
    ) {
      setConnectionForm(getConnectionFormState(firstEntry))
    }
  })

  createEffect(() => {
    if (!activeCatalogEntry()) {
      return
    }

    void loadProviderAuth()
  })

  createEffect(() => {
    const job = codexLoginJob()
    const providerKind = connectionForm.providerKind
    const isRunning = providerKind === 'codex' && providerAuth()?.status === 'pending' && job?.state === 'running'

    if (!isRunning || !job?.id) {
      return
    }

    const interval = setInterval(() => {
      void finishProviderAuthStep({payload: {authMode: 'codex-cli', jobId: job.id}, silent: true}).catch(() => {
        return
      })
    }, 1000)

    onCleanup(() => {
      clearInterval(interval)
    })
  })

  const submitConnectionForm = async () => {
    setPageError('')

    try {
      const authPayload: ProviderAuthLifecyclePayload = {
        authMode: providerAuth()?.payload?.authMode ?? null,
        providerState: providerAuth()?.payload?.providerState,
        secretValue: getTrimmedValue(connectionForm.apiKey) || null,
      }
      const authResult = await finishProviderAuthStep({payload: authPayload})

      if (authResult.status !== 'complete') {
        throw new Error(authResult.message)
      }

      await createConnectionMutation.mutateAsync({
        apiKey: authResult.payload?.secretValue ?? (getTrimmedValue(connectionForm.apiKey) || undefined),
        baseURL: getNullableTrimmedValue(connectionForm.baseURL),
        label: connectionForm.label,
        manualWorkerUrls: getWorkerUrlsFromInputValue(connectionForm.manualWorkerUrls),
        providerKind: connectionForm.providerKind,
        workerUrlMode: connectionForm.workerUrlMode,
      })
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Failed to create provider connection')
    }
  }

  const startCodexDeviceLogin = async () => {
    setAuthError('')
    setIsLoadingAuth(true)

    try {
      const result = await beginProviderAuthLifecycle({providerKind: connectionForm.providerKind})
      setProviderAuth(result)
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Failed to start Codex login')
    } finally {
      setIsLoadingAuth(false)
    }
  }

  return (
    <div class="min-h-screen bg-gray-50 p-6">
      <div class="mx-auto max-w-6xl space-y-6">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 class="text-2xl font-bold text-gray-900">Add Provider</h1>
            <p class="text-sm text-gray-500">
              Create a provider connection here. Models are added later from the main Providers and Models page.
            </p>
          </div>
          <Button as={Link} to="/admin/models" variant="outline">
            Back to Providers and Models
          </Button>
        </div>

        <Show when={pageError()}>
          <div class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{pageError()}</div>
        </Show>

        <Show when={providerConnectionsQuery.isLoading}>
          <div class="rounded-lg border border-gray-200 bg-white px-4 py-10 text-center text-sm text-gray-500 shadow-sm">
            Loading provider catalog...
          </div>
        </Show>

        <Show when={providerConnectionsQuery.isError}>
          <div class="rounded-lg border border-red-200 bg-red-50 p-4">
            <p class="text-red-600">Failed to load providers</p>
            <Button
              class="mt-2"
              onClick={() => {
                return void providerConnectionsQuery.refetch()
              }}
            >
              Retry
            </Button>
          </div>
        </Show>

        <Show when={!providerConnectionsQuery.isLoading && !providerConnectionsQuery.isError}>
          <div class="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
            <div class="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
              <div class="mb-4">
                <h2 class="text-lg font-semibold text-gray-900">Choose a Provider</h2>
                <p class="text-sm text-gray-500">
                  Pick the provider you want to connect, then finish its auth and connection details.
                </p>
              </div>
              <div class="grid gap-3 md:grid-cols-2">
                <For each={catalog()}>
                  {(entry) => {
                    return (
                      <button
                        class={`rounded-xl border px-4 py-4 text-left transition ${
                          connectionForm.providerKind === entry.kind
                            ? 'border-blue-500 bg-blue-50 shadow-sm'
                            : 'border-gray-200 bg-gray-50 hover:border-gray-300 hover:bg-white'
                        }`}
                        onClick={() => {
                          selectCatalogEntry(entry)
                        }}
                        type="button"
                      >
                        <div class="flex items-center justify-between gap-3">
                          <div class="text-base font-semibold text-gray-900">{entry.label}</div>
                          <div class="rounded-full bg-white px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-gray-500">
                            {entry.kind}
                          </div>
                        </div>
                        <p class="mt-2 text-sm text-gray-600">{entry.description}</p>
                        <div class="mt-3 flex flex-wrap gap-2 text-xs text-gray-500">
                          <span class="rounded-full bg-white px-2 py-1">
                            {entry.supportsDiscovery ? 'Discovery' : 'Manual'}
                          </span>
                          <span class="rounded-full bg-white px-2 py-1">
                            {entry.requiresApiKey ? 'API key' : 'No key required'}
                          </span>
                        </div>
                      </button>
                    )
                  }}
                </For>
              </div>
            </div>

            <div class="space-y-6">
              <Show when={!shouldHideCodexConnectCard()}>
                <div class="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
                  <div class="mb-4">
                    <h2 class="text-lg font-semibold text-gray-900">
                      Connect {activeCatalogEntry()?.label ?? 'Provider'}
                    </h2>
                    <p class="text-sm text-gray-500">
                      This creates the provider connection. You will add or sync models afterward.
                    </p>
                  </div>

                  <div class="space-y-4">
                    <Show when={providerAuth() || isLoadingAuth() || authError()}>
                      <div class={`rounded-lg border px-4 py-3 text-sm ${getAuthMessageClass(providerAuth()?.status)}`}>
                        <Show when={isLoadingAuth()}>
                          <p>Checking provider auth...</p>
                        </Show>
                        <Show when={!isLoadingAuth() && providerAuth()}>
                          <p>{providerAuth()?.message}</p>
                        </Show>
                        <Show when={authError()}>
                          <p class="text-red-700">{authError()}</p>
                        </Show>
                      </div>
                    </Show>

                    <ProviderConnectionForm
                      apiKeyLabel={apiKeyField()?.label}
                      apiKeyOptional={apiKeyField()?.optional}
                      kind={connectionForm.providerKind}
                      onApiKeyChange={(value) => {
                        setConnectionForm('apiKey', value)
                      }}
                      onBaseURLChange={(value) => {
                        setConnectionForm('baseURL', value)
                      }}
                      onLabelChange={(value) => {
                        setConnectionForm('label', value)
                      }}
                      onWorkerUrlModeChange={(value) => {
                        setConnectionForm('workerUrlMode', value)
                      }}
                      onWorkerUrlsChange={(value) => {
                        setConnectionForm('manualWorkerUrls', value)
                      }}
                      providerLabel={activeCatalogEntry()?.label ?? connectionForm.providerKind}
                      runtimeWorkerUrls={activeRuntimeWorkerUrls()}
                      showApiKeyField={shouldShowApiKeyField()}
                      supportsRuntimeWorkerUrls={supportsRuntimeWorkerUrls(connectionForm.providerKind)}
                      supportsWorkerUrls={Boolean(activeCatalogEntry()?.supportsWorkerUrls)}
                      values={connectionForm}
                    />

                    <Button
                      disabled={createConnectionMutation.isPending || isFinishingAuth() || isLoadingAuth()}
                      onClick={() => {
                        return void submitConnectionForm()
                      }}
                    >
                      {createConnectionMutation.isPending || isFinishingAuth()
                        ? 'Creating Provider...'
                        : 'Create Provider'}
                    </Button>
                  </div>
                </div>
              </Show>

              <Show when={connectionForm.providerKind === 'codex'}>
                <div class="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
                  <h2 class="text-lg font-semibold text-gray-900">Codex Login</h2>
                  <div class="mt-4 space-y-3 text-sm text-gray-700">
                    <Show when={isLoadingAuth()}>
                      <p class="text-gray-500">Checking Codex status...</p>
                    </Show>
                    <Show when={codexProviderState()}>
                      <div>
                        <span class="font-medium">Login:</span>{' '}
                        <span class={codexProviderState()?.cli?.loggedIn ? 'text-green-700' : 'text-amber-700'}>
                          {codexProviderState()?.cli?.loggedIn
                            ? `Logged in${codexProviderState()?.cli?.method ? ` (${codexProviderState()?.cli?.method})` : ''}`
                            : 'Not logged in'}
                        </span>
                      </div>
                      <div>
                        <span class="font-medium">App-server:</span>{' '}
                        <span class={codexProviderState()?.appServerReady ? 'text-green-700' : 'text-amber-700'}>
                          {codexProviderState()?.appServerReady ? 'Ready' : 'Not ready'}
                        </span>
                      </div>
                      <Show when={codexProviderState()?.codexBin}>
                        <p class="break-all font-mono text-xs text-gray-500">{codexProviderState()?.codexBin}</p>
                      </Show>
                      <p class="text-xs text-gray-500">{providerAuth()?.message}</p>
                    </Show>

                    <Show when={existingCodexConnection()}>
                      <div class="rounded-md border border-green-200 bg-green-50 p-4 text-sm text-green-800">
                        Codex App is already added as `{existingCodexConnection()?.label}`. Manage it on the Providers
                        and Models page.
                      </div>
                    </Show>

                    <Show when={!codexProviderState()?.cli?.loggedIn && !existingCodexConnection()}>
                      <Button
                        disabled={isLoadingAuth()}
                        onClick={() => {
                          return void startCodexDeviceLogin()
                        }}
                      >
                        {isLoadingAuth() ? 'Starting Codex Login...' : 'Sign in to Codex'}
                      </Button>
                    </Show>

                    <Show when={authError()}>
                      <p class="text-sm text-red-600">{authError()}</p>
                    </Show>

                    <Show when={canCreateCodexProvider()}>
                      <Button
                        disabled={createConnectionMutation.isPending || isFinishingAuth()}
                        onClick={() => {
                          return void submitConnectionForm()
                        }}
                      >
                        {createConnectionMutation.isPending || isFinishingAuth()
                          ? 'Creating Provider...'
                          : 'Create Provider'}
                      </Button>
                    </Show>

                    <Show when={codexLoginJob()}>
                      <div class="rounded-md border border-gray-200 bg-gray-50 p-4">
                        <p class="mb-2 text-sm font-medium text-gray-900">Device login</p>
                        <Show when={codexLoginJob()?.deviceUrl}>
                          <p class="text-sm text-gray-700">
                            Open:{' '}
                            <a
                              class="text-blue-700 underline"
                              href={codexLoginJob()?.deviceUrl ?? '#'}
                              rel="noreferrer"
                              target="_blank"
                            >
                              {codexLoginJob()?.deviceUrl}
                            </a>
                          </p>
                        </Show>
                        <Show when={codexLoginJob()?.deviceCode}>
                          <p class="text-sm text-gray-700">
                            Code: <span class="font-mono">{codexLoginJob()?.deviceCode}</span>
                          </p>
                        </Show>
                        <pre class="mt-3 whitespace-pre-wrap font-mono text-xs text-gray-800">
                          {codexLoginJob()?.output.join('\n')}
                        </pre>
                      </div>
                    </Show>
                  </div>
                </div>
              </Show>
            </div>
          </div>
        </Show>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/admin/models/add-provider' as never)({component: AddProviderPage})
