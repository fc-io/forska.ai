import {createMutation, useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link, useNavigate} from '@tanstack/solid-router'
import {createEffect, createSignal, For, onCleanup, Show} from 'solid-js'
import {createStore} from 'solid-js/store'

import {Button} from '../../../../components/ui/button.tsx'
import {
  type CodexDeviceLoginJob,
  createProviderConnection,
  fetchCodexLoginJob,
  fetchCodexStatus,
  fetchProviderConnections,
  getNullableTrimmedValue,
  getTrimmedValue,
  getWorkerUrlsFromInputValue,
  type ProviderCatalogEntry,
  startCodexLogin,
} from './providerConnectionsClient.ts'

type ConnectionFormState = {apiKey: string; baseURL: string; label: string; providerKind: string; workerUrls: string}

const getConnectionFormState = (catalogEntry: ProviderCatalogEntry | null): ConnectionFormState => {
  return {
    apiKey: '',
    baseURL: catalogEntry?.defaultBaseURL ?? '',
    label: catalogEntry?.label ?? '',
    providerKind: catalogEntry?.kind ?? 'openai',
    workerUrls: '',
  }
}

const AddProviderPage = () => {
  const navigate = useNavigate()
  const providerConnectionsQuery = useQuery(() => {
    return {
      queryKey: ['provider-connections'],
      queryFn: fetchProviderConnections,
      refetchOnWindowFocus: false,
      staleTime: 1000 * 30,
      suspense: false,
    }
  })
  const [connectionForm, setConnectionForm] = createStore<ConnectionFormState>(getConnectionFormState(null))
  const [pageError, setPageError] = createSignal('')
  const [codexLoginJobId, setCodexLoginJobId] = createSignal<string | null>(null)
  const [codexLoginJob, setCodexLoginJob] = createSignal<CodexDeviceLoginJob | null>(null)
  const [isStartingCodexLogin, setIsStartingCodexLogin] = createSignal(false)
  const [codexLoginError, setCodexLoginError] = createSignal('')

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

  const activeCatalogEntry = () => {
    return (
      catalog().find((entry) => {
        return entry.kind === connectionForm.providerKind
      }) ?? null
    )
  }

  const existingCodexConnection = () => {
    return (
      connections().find((connection) => {
        return connection.providerKind === 'codex'
      }) ?? null
    )
  }

  const codexStatusQuery = useQuery(() => {
    return {
      enabled: connectionForm.providerKind === 'codex',
      queryKey: ['codex-status', connectionForm.providerKind],
      queryFn: fetchCodexStatus,
      refetchOnWindowFocus: false,
      staleTime: 60 * 1000,
      suspense: false,
    }
  })

  const shouldHideCodexConnectCard = () => {
    return (
      connectionForm.providerKind === 'codex'
      && Boolean(
        existingCodexConnection() || codexStatusQuery.data?.cli.loggedIn || codexStatusQuery.data?.appServerReady,
      )
    )
  }

  const canCreateCodexProvider = () => {
    return (
      connectionForm.providerKind === 'codex'
      && !existingCodexConnection()
      && Boolean(codexStatusQuery.data?.cli.loggedIn && codexStatusQuery.data?.appServerReady)
    )
  }

  const selectCatalogEntry = (entry: ProviderCatalogEntry) => {
    setPageError('')
    setConnectionForm(getConnectionFormState(entry))
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
    const jobId = codexLoginJobId()
    const job = codexLoginJob()
    const isRunning = Boolean(jobId && job?.state === 'running')

    if (!jobId || !isRunning) {
      return
    }

    const interval = setInterval(() => {
      void fetchCodexLoginJob(jobId)
        .then((updated) => {
          setCodexLoginJob(updated)
          if (updated.state !== 'running') {
            void codexStatusQuery.refetch()
          }
        })
        .catch((error) => {
          setCodexLoginError(error instanceof Error ? error.message : 'Failed to fetch Codex login job')
        })
    }, 1000)

    onCleanup(() => {
      clearInterval(interval)
    })
  })

  const submitConnectionForm = async () => {
    setPageError('')

    try {
      await createConnectionMutation.mutateAsync({
        apiKey: getTrimmedValue(connectionForm.apiKey) || undefined,
        baseURL: getNullableTrimmedValue(connectionForm.baseURL),
        label: connectionForm.label,
        providerKind: connectionForm.providerKind,
        workerUrls: getWorkerUrlsFromInputValue(connectionForm.workerUrls),
      })
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Failed to create provider connection')
    }
  }

  const startCodexDeviceLogin = async () => {
    setIsStartingCodexLogin(true)
    setCodexLoginError('')

    try {
      const result = await startCodexLogin()
      if (!result.job) {
        await codexStatusQuery.refetch()
        return
      }

      setCodexLoginJobId(result.job.id)
      setCodexLoginJob(result.job)
    } catch (error) {
      setCodexLoginError(error instanceof Error ? error.message : 'Failed to start Codex login')
    } finally {
      setIsStartingCodexLogin(false)
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
                  Pick the provider you want to connect, then fill in its connection details.
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
                    <div>
                      <label class="mb-2 block text-sm font-medium text-gray-700">Provider</label>
                      <div class="rounded-md border border-gray-200 bg-gray-50 px-3 py-3 text-sm text-gray-700">
                        {activeCatalogEntry()?.label ?? connectionForm.providerKind}
                      </div>
                    </div>

                    <div>
                      <label class="mb-2 block text-sm font-medium text-gray-700">Connection Label</label>
                      <input
                        class="w-full rounded-md border border-gray-300 px-3 py-3 text-sm text-gray-900"
                        onInput={(event) => {
                          setConnectionForm('label', event.currentTarget.value)
                        }}
                        type="text"
                        value={connectionForm.label}
                      />
                    </div>

                    <Show when={connectionForm.providerKind !== 'codex'}>
                      <div>
                        <label class="mb-2 block text-sm font-medium text-gray-700">Base URL</label>
                        <input
                          class="w-full rounded-md border border-gray-300 px-3 py-3 text-sm text-gray-900"
                          onInput={(event) => {
                            setConnectionForm('baseURL', event.currentTarget.value)
                          }}
                          type="text"
                          value={connectionForm.baseURL}
                        />
                      </div>
                    </Show>

                    <Show when={activeCatalogEntry()?.supportsWorkerUrls}>
                      <div>
                        <label class="mb-2 block text-sm font-medium text-gray-700">Worker URLs</label>
                        <input
                          class="w-full rounded-md border border-gray-300 px-3 py-3 text-sm text-gray-900"
                          onInput={(event) => {
                            setConnectionForm('workerUrls', event.currentTarget.value)
                          }}
                          placeholder="http://127.0.0.1:30000, http://127.0.0.1:30001"
                          type="text"
                          value={connectionForm.workerUrls}
                        />
                      </div>
                    </Show>

                    <Show when={activeCatalogEntry()?.requiresApiKey}>
                      <div>
                        <label class="mb-2 block text-sm font-medium text-gray-700">API Key</label>
                        <input
                          class="w-full rounded-md border border-gray-300 px-3 py-3 text-sm text-gray-900"
                          onInput={(event) => {
                            setConnectionForm('apiKey', event.currentTarget.value)
                          }}
                          type="password"
                          value={connectionForm.apiKey}
                        />
                      </div>
                    </Show>

                    <Button
                      disabled={createConnectionMutation.isPending}
                      onClick={() => {
                        return void submitConnectionForm()
                      }}
                    >
                      {createConnectionMutation.isPending ? 'Creating Provider...' : 'Create Provider'}
                    </Button>
                  </div>
                </div>
              </Show>

              <Show when={connectionForm.providerKind === 'codex'}>
                <div class="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
                  <h2 class="text-lg font-semibold text-gray-900">Codex Login</h2>
                  <div class="mt-4 space-y-3 text-sm text-gray-700">
                    <Show when={codexStatusQuery.isLoading}>
                      <p class="text-gray-500">Checking Codex status...</p>
                    </Show>
                    <Show when={codexStatusQuery.data}>
                      <div>
                        <span class="font-medium">Login:</span>{' '}
                        <span class={codexStatusQuery.data?.cli.loggedIn ? 'text-green-700' : 'text-amber-700'}>
                          {codexStatusQuery.data?.cli.loggedIn
                            ? `Logged in${codexStatusQuery.data?.cli.method ? ` (${codexStatusQuery.data?.cli.method})` : ''}`
                            : 'Not logged in'}
                        </span>
                      </div>
                      <div>
                        <span class="font-medium">App-server:</span>{' '}
                        <span class={codexStatusQuery.data?.appServerReady ? 'text-green-700' : 'text-amber-700'}>
                          {codexStatusQuery.data?.appServerReady ? 'Ready' : 'Not ready'}
                        </span>
                      </div>
                      <p class="break-all font-mono text-xs text-gray-500">{codexStatusQuery.data?.codexBin}</p>
                      <p class="text-xs text-gray-500">{codexStatusQuery.data?.message}</p>
                    </Show>

                    <Show when={existingCodexConnection()}>
                      <div class="rounded-md border border-green-200 bg-green-50 p-4 text-sm text-green-800">
                        Codex App is already added as `{existingCodexConnection()?.label}`. Manage it on the Providers
                        and Models page.
                      </div>
                    </Show>

                    <Show when={!codexStatusQuery.data?.cli.loggedIn}>
                      <Button
                        disabled={isStartingCodexLogin()}
                        onClick={() => {
                          return void startCodexDeviceLogin()
                        }}
                      >
                        {isStartingCodexLogin() ? 'Starting Codex Login...' : 'Sign in to Codex'}
                      </Button>
                    </Show>

                    <Show when={canCreateCodexProvider()}>
                      <Button
                        disabled={createConnectionMutation.isPending}
                        onClick={() => {
                          return void submitConnectionForm()
                        }}
                      >
                        {createConnectionMutation.isPending ? 'Creating Provider...' : 'Create Provider'}
                      </Button>
                    </Show>

                    <Show when={codexLoginError()}>
                      <p class="text-sm text-red-600">{codexLoginError()}</p>
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
