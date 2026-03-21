import {createMutation, useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {createEffect, createSignal, For, onCleanup, Show} from 'solid-js'
import {createStore} from 'solid-js/store'

import {Button} from '../../../../components/ui/button.tsx'
import {ProviderConnectionForm} from './providerConnectionForm.tsx'
import {
  addManualProviderModel,
  type CodexDeviceLoginJob,
  deleteProviderConnection,
  fetchCodexLoginJob,
  fetchCodexStatus,
  fetchProviderConnections,
  formatTimestamp,
  getFormDataString,
  getNullableTrimmedValue,
  getProviderCatalogLabel,
  getProviderModelContextLength,
  getProviderModelDiscoverySource,
  getProviderModelReasoningEfforts,
  getProviderSecretStatus,
  getRuntimeWorkerUrlsForProvider,
  getTrimmedValue,
  getWorkerSourceLabel,
  getWorkerUrlsFromInputValue,
  getWorkerUrlsInputValue,
  type ProviderConnection,
  type ProviderModel,
  startCodexLogin,
  supportsRuntimeWorkerUrls,
  syncProviderConnectionModels,
  testProviderConnectionApi,
  updateProviderConnection,
  updateProviderModel,
} from './providerConnectionsClient.ts'

type ConnectionFormState = {
  apiKey: string
  baseURL: string
  enabled: boolean
  label: string
  manualWorkerUrls: string
  providerKind: string
  workerUrlMode: 'manual' | 'runtime'
}

type ManualModelFormState = {displayName: string; remoteModelId: string; variant: string}

const getConnectionFormState = (connection: ProviderConnection | null): ConnectionFormState => {
  return {
    apiKey: '',
    baseURL: connection?.baseURL ?? '',
    enabled: connection?.enabled ?? true,
    label: connection?.label ?? '',
    manualWorkerUrls: getWorkerUrlsInputValue(connection?.config.manualWorkerUrls ?? []),
    providerKind: connection?.providerKind ?? 'openai',
    workerUrlMode: connection?.config.workerUrlMode ?? 'manual',
  }
}

const AdminModels = () => {
  const providerConnectionsQuery = useQuery(() => {
    return {
      queryKey: ['provider-connections'],
      queryFn: fetchProviderConnections,
      refetchOnWindowFocus: false,
      staleTime: 1000 * 30,
      suspense: false,
    }
  })
  const [selectedConnectionId, setSelectedConnectionId] = createSignal<string | null>(null)
  const [connectionForm, setConnectionForm] = createStore<ConnectionFormState>(getConnectionFormState(null))
  const [manualModelForm, setManualModelForm] = createStore<ManualModelFormState>({
    displayName: '',
    remoteModelId: '',
    variant: '',
  })
  const [pageMessage, setPageMessage] = createSignal('')
  const [pageError, setPageError] = createSignal('')
  const [codexLoginJobId, setCodexLoginJobId] = createSignal<string | null>(null)
  const [codexLoginJob, setCodexLoginJob] = createSignal<CodexDeviceLoginJob | null>(null)
  const [isStartingCodexLogin, setIsStartingCodexLogin] = createSignal(false)
  const [codexLoginError, setCodexLoginError] = createSignal('')

  const updateConnectionMutation = createMutation(() => {
    return {
      mutationFn: updateProviderConnection,
      onSuccess: async (connection: ProviderConnection) => {
        setPageError('')
        setPageMessage(`Updated ${connection.label}`)
        setSelectedConnectionId(connection.id)
        setConnectionForm(getConnectionFormState(connection))
        await providerConnectionsQuery.refetch()
      },
    }
  })
  const testConnectionMutation = createMutation(() => {
    return {
      mutationFn: testProviderConnectionApi,
      onSuccess: async (result) => {
        setPageError('')
        setPageMessage(result.message)
        await providerConnectionsQuery.refetch()
      },
    }
  })
  const syncConnectionMutation = createMutation(() => {
    return {
      mutationFn: syncProviderConnectionModels,
      onSuccess: async (result) => {
        setPageError('')
        setPageMessage(`Synced ${result.count} models`)
        await providerConnectionsQuery.refetch()
      },
    }
  })
  const deleteConnectionMutation = createMutation(() => {
    return {
      mutationFn: deleteProviderConnection,
      onSuccess: async (result) => {
        setPageError('')
        setPageMessage(`Removed provider connection and ${result.deletedModelCount} models`)
        setSelectedConnectionId(null)
        setConnectionForm(getConnectionFormState(null))
        await providerConnectionsQuery.refetch()
      },
    }
  })
  const addManualModelMutation = createMutation(() => {
    return {
      mutationFn: addManualProviderModel,
      onSuccess: async (result) => {
        setPageError('')
        setPageMessage(`Added model ${result.modelId}`)
        setManualModelForm({displayName: '', remoteModelId: '', variant: ''})
        await providerConnectionsQuery.refetch()
      },
    }
  })
  const updateModelMutation = createMutation(() => {
    return {
      mutationFn: updateProviderModel,
      onSuccess: async (model: ProviderModel) => {
        setPageError('')
        setPageMessage(`Updated ${model.displayName ?? model.name}`)
        await providerConnectionsQuery.refetch()
      },
    }
  })

  const connections = () => {
    return providerConnectionsQuery.data?.connections ?? []
  }

  const catalog = () => {
    return providerConnectionsQuery.data?.catalog ?? []
  }

  const runtime = () => {
    return providerConnectionsQuery.data?.runtime ?? null
  }

  const selectedConnection = () => {
    return (
      connections().find((connection) => {
        return connection.id === selectedConnectionId()
      }) ?? null
    )
  }

  const activeCatalogEntry = () => {
    const connection = selectedConnection()

    return (
      catalog().find((entry) => {
        return entry.kind === connection?.providerKind
      }) ?? null
    )
  }

  const activeRuntimeWorkerUrls = () => {
    return getRuntimeWorkerUrlsForProvider({providerKind: connectionForm.providerKind, runtime: runtime()})
  }

  const shouldShowConnectionApiKeyField = () => {
    const connection = selectedConnection()

    return Boolean(
      connection
      && (connection.hasSecret
        || ['openai', 'anthropic', 'google', 'openrouter', 'sglang', 'vllm'].includes(connection.providerKind)),
    )
  }

  const isOptionalConnectionApiKey = () => {
    const connection = selectedConnection()

    return Boolean(connection && ['sglang', 'vllm'].includes(connection.providerKind))
  }

  const getConnectionProviderLabel = (providerKind: string) => {
    return getProviderCatalogLabel(catalog(), providerKind)
  }

  const codexStatusQuery = useQuery(() => {
    return {
      enabled: selectedConnection()?.providerKind === 'codex',
      queryKey: ['codex-status', selectedConnection()?.id ?? 'none'],
      queryFn: fetchCodexStatus,
      refetchOnWindowFocus: false,
      staleTime: 60 * 1000,
      suspense: false,
    }
  })

  const loadSelectedConnection = (connection: ProviderConnection) => {
    setSelectedConnectionId(connection.id)
    setConnectionForm(getConnectionFormState(connection))
    setManualModelForm({displayName: '', remoteModelId: '', variant: ''})
    setPageError('')
    setPageMessage('')
  }

  const isSelectedConnection = (connectionId: string) => {
    return selectedConnectionId() === connectionId
  }

  createEffect(() => {
    const queryConnections = connections()
    const currentSelection = selectedConnectionId()
    const hasSelectedConnection = queryConnections.some((connection) => {
      return connection.id === currentSelection
    })

    if (!hasSelectedConnection && queryConnections[0]) {
      loadSelectedConnection(queryConnections[0])
      return
    }

    if (!queryConnections[0]) {
      setSelectedConnectionId(null)
      setConnectionForm(getConnectionFormState(null))
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
    const connection = selectedConnection()

    if (!connection) {
      return
    }

    setPageError('')
    setPageMessage('')

    try {
      await updateConnectionMutation.mutateAsync({
        apiKey: getTrimmedValue(connectionForm.apiKey) || undefined,
        baseURL: getNullableTrimmedValue(connectionForm.baseURL),
        enabled: connectionForm.enabled,
        id: connection.id,
        label: connectionForm.label,
        manualWorkerUrls: getWorkerUrlsFromInputValue(connectionForm.manualWorkerUrls),
        workerUrlMode: connectionForm.workerUrlMode,
      })
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Failed to save provider connection')
    }
  }

  const clearStoredSecret = async () => {
    const connection = selectedConnection()

    if (!connection) {
      return
    }

    setPageError('')
    setPageMessage('')

    try {
      await updateConnectionMutation.mutateAsync({
        baseURL: connection.baseURL,
        clearSecret: true,
        enabled: connection.enabled,
        id: connection.id,
        label: connection.label,
        manualWorkerUrls: connection.config.manualWorkerUrls,
        workerUrlMode: connection.config.workerUrlMode,
      })
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Failed to clear provider secret')
    }
  }

  const toggleConnectionEnabled = async (connection: ProviderConnection) => {
    setPageError('')
    setPageMessage('')

    try {
      await updateConnectionMutation.mutateAsync({
        baseURL: connection.baseURL,
        enabled: !connection.enabled,
        id: connection.id,
        label: connection.label,
        manualWorkerUrls: connection.config.manualWorkerUrls,
        workerUrlMode: connection.config.workerUrlMode,
      })
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Failed to toggle provider connection')
    }
  }

  const runConnectionTest = async (connectionId: string) => {
    setPageError('')
    setPageMessage('')

    try {
      await testConnectionMutation.mutateAsync(connectionId)
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Failed to test provider connection')
    }
  }

  const runConnectionSync = async (connectionId: string) => {
    setPageError('')
    setPageMessage('')

    try {
      await syncConnectionMutation.mutateAsync(connectionId)
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Failed to sync provider models')
    }
  }

  const removeProviderConnection = async (connection: ProviderConnection) => {
    setPageError('')
    setPageMessage('')

    const confirmed = globalThis.confirm(
      `Remove ${connection.label}? This deletes ${connection.models.length} provider models if they are not referenced by projects, comparison projects, or judgments.`,
    )

    if (!confirmed) {
      return
    }

    try {
      await deleteConnectionMutation.mutateAsync(connection.id)
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Failed to remove provider connection')
    }
  }

  const submitManualModel = async () => {
    const connection = selectedConnection()

    if (!connection) {
      return
    }

    setPageError('')
    setPageMessage('')

    try {
      await addManualModelMutation.mutateAsync({
        displayName: getTrimmedValue(manualModelForm.displayName) || undefined,
        id: connection.id,
        remoteModelId: manualModelForm.remoteModelId,
        variant: getTrimmedValue(manualModelForm.variant) || undefined,
      })
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Failed to add manual model')
    }
  }

  const submitModelForm = async (event: Event, model: ProviderModel) => {
    event.preventDefault()
    setPageError('')
    setPageMessage('')
    const formData = new FormData(event.currentTarget as HTMLFormElement)

    try {
      await updateModelMutation.mutateAsync({
        displayName: getFormDataString(formData, 'displayName'),
        enabled: formData.get('enabled') === 'on',
        id: model.id,
        variant: getFormDataString(formData, 'variant'),
      })
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Failed to update model')
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
      <div class="mx-auto max-w-7xl space-y-6">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 class="text-2xl font-bold text-gray-900">Providers and Models</h1>
            <p class="text-sm text-gray-500">
              Add providers on their own page, then manage each provider connection and its models here.
            </p>
          </div>
          <Button as={Link} to="/admin/models/add-provider">
            Add New Provider
          </Button>
        </div>

        <Show when={pageMessage()}>
          <div class="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
            {pageMessage()}
          </div>
        </Show>

        <Show when={pageError()}>
          <div class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{pageError()}</div>
        </Show>

        <Show when={providerConnectionsQuery.isLoading}>
          <div class="rounded-lg border border-gray-200 bg-white px-4 py-10 text-center text-sm text-gray-500 shadow-sm">
            Loading providers...
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
          <div class="grid gap-6 xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
            <div class="space-y-6">
              <Show
                when={selectedConnection()}
                fallback={
                  <div class="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
                    <h2 class="text-lg font-semibold text-gray-900">No Provider Selected</h2>
                    <p class="mt-2 text-sm text-gray-500">
                      Add a provider first, then come back here to edit provider settings and add models.
                    </p>
                    <Button as={Link} class="mt-4" to="/admin/models/add-provider">
                      Add New Provider
                    </Button>
                  </div>
                }
              >
                {(connection) => {
                  return (
                    <>
                      <div class="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
                        <div class="mb-4">
                          <h2 class="text-lg font-semibold text-gray-900">Edit {connection().label}</h2>
                          <p class="text-sm text-gray-500">
                            Update provider settings, stored secrets, and runtime config.
                          </p>
                        </div>

                        <div class="space-y-4">
                          <ProviderConnectionForm
                            apiKeyOptional={isOptionalConnectionApiKey()}
                            hasStoredSecret={connection().hasSecret}
                            kind={connection().providerKind}
                            onApiKeyChange={(value) => {
                              setConnectionForm('apiKey', value)
                            }}
                            onBaseURLChange={(value) => {
                              setConnectionForm('baseURL', value)
                            }}
                            onClearStoredSecret={() => {
                              return void clearStoredSecret()
                            }}
                            onEnabledChange={(value) => {
                              setConnectionForm('enabled', value)
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
                            providerLabel={activeCatalogEntry()?.label ?? connection().providerKind}
                            runtimeWorkerUrls={activeRuntimeWorkerUrls()}
                            secretStatus={getProviderSecretStatus(connection())}
                            showApiKeyField={shouldShowConnectionApiKeyField()}
                            showEnabledToggle={true}
                            supportsRuntimeWorkerUrls={supportsRuntimeWorkerUrls(connection().providerKind)}
                            supportsWorkerUrls={Boolean(activeCatalogEntry()?.supportsWorkerUrls)}
                            values={connectionForm}
                          />

                          <Show
                            when={
                              supportsRuntimeWorkerUrls(connection().providerKind)
                              && connectionForm.workerUrlMode === 'runtime'
                            }
                          >
                            <div
                              class={`rounded-lg border px-4 py-3 text-sm ${activeRuntimeWorkerUrls().length > 0 ? 'border-blue-200 bg-blue-50 text-blue-900' : 'border-amber-200 bg-amber-50 text-amber-900'}`}
                            >
                              <p class="font-medium">Runtime-only worker routing</p>
                              <p class="mt-1">
                                This connection ignores saved manual worker URLs and uses only launcher-discovered
                                runtime worker URLs for the current server session.
                              </p>
                              <p class="mt-1 break-words">
                                Active runtime URLs:{' '}
                                {activeRuntimeWorkerUrls().length > 0
                                  ? activeRuntimeWorkerUrls().join(', ')
                                  : 'none detected'}
                              </p>
                              <p class="mt-1 text-xs opacity-80">
                                The saved base URL still stays in provider config; runtime-only affects worker routing
                                only.
                              </p>
                            </div>
                          </Show>

                          <div class="flex flex-wrap gap-3">
                            <button
                              class="rounded-md bg-blue-600 px-4 py-3 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                              disabled={updateConnectionMutation.isPending}
                              onClick={() => {
                                return void submitConnectionForm()
                              }}
                              type="button"
                            >
                              {updateConnectionMutation.isPending ? 'Saving...' : 'Save Provider'}
                            </button>
                            <button
                              class="rounded-md border border-gray-300 px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
                              disabled={testConnectionMutation.isPending}
                              onClick={() => {
                                return void runConnectionTest(connection().id)
                              }}
                              type="button"
                            >
                              {testConnectionMutation.isPending ? 'Testing...' : 'Test'}
                            </button>
                            <button
                              class="rounded-md border border-gray-300 px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
                              disabled={syncConnectionMutation.isPending || !activeCatalogEntry()?.supportsDiscovery}
                              onClick={() => {
                                return void runConnectionSync(connection().id)
                              }}
                              type="button"
                            >
                              {syncConnectionMutation.isPending ? 'Syncing...' : 'Sync Models'}
                            </button>
                          </div>
                        </div>
                      </div>

                      <Show when={connection().providerKind === 'codex'}>
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
                                <span
                                  class={codexStatusQuery.data?.appServerReady ? 'text-green-700' : 'text-amber-700'}
                                >
                                  {codexStatusQuery.data?.appServerReady ? 'Ready' : 'Not ready'}
                                </span>
                              </div>
                              <p class="break-all font-mono text-xs text-gray-500">{codexStatusQuery.data?.codexBin}</p>
                              <p class="text-xs text-gray-500">{codexStatusQuery.data?.message}</p>
                            </Show>

                            <Show when={!codexStatusQuery.data?.cli.loggedIn}>
                              <button
                                class="rounded-md bg-blue-600 px-4 py-3 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                                disabled={isStartingCodexLogin()}
                                onClick={() => {
                                  return void startCodexDeviceLogin()
                                }}
                                type="button"
                              >
                                {isStartingCodexLogin() ? 'Starting Codex Login...' : 'Sign in to Codex'}
                              </button>
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

                      <div class="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
                        <h2 class="text-lg font-semibold text-gray-900">Add Model</h2>
                        <p class="mt-1 text-sm text-gray-500">
                          Adding models is separate from adding providers. Use this after the provider connection
                          already exists.
                        </p>
                        <div class="mt-4 space-y-4">
                          <div>
                            <label class="mb-2 block text-sm font-medium text-gray-700">Remote Model ID</label>
                            <input
                              class="w-full rounded-md border border-gray-300 px-3 py-3 text-sm text-gray-900"
                              onInput={(event) => {
                                setManualModelForm('remoteModelId', event.currentTarget.value)
                              }}
                              type="text"
                              value={manualModelForm.remoteModelId}
                            />
                          </div>
                          <div>
                            <label class="mb-2 block text-sm font-medium text-gray-700">Display Name</label>
                            <input
                              class="w-full rounded-md border border-gray-300 px-3 py-3 text-sm text-gray-900"
                              onInput={(event) => {
                                setManualModelForm('displayName', event.currentTarget.value)
                              }}
                              placeholder="Optional"
                              type="text"
                              value={manualModelForm.displayName}
                            />
                          </div>
                          <div>
                            <label class="mb-2 block text-sm font-medium text-gray-700">Variant</label>
                            <input
                              class="w-full rounded-md border border-gray-300 px-3 py-3 text-sm text-gray-900"
                              onInput={(event) => {
                                setManualModelForm('variant', event.currentTarget.value)
                              }}
                              placeholder="Optional"
                              type="text"
                              value={manualModelForm.variant}
                            />
                          </div>
                          <button
                            class="rounded-md border border-gray-300 px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
                            disabled={addManualModelMutation.isPending}
                            onClick={() => {
                              return void submitManualModel()
                            }}
                            type="button"
                          >
                            {addManualModelMutation.isPending ? 'Adding...' : 'Add Model'}
                          </button>
                        </div>
                      </div>
                    </>
                  )
                }}
              </Show>
            </div>

            <div class="space-y-6">
              <div class="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
                <div class="mb-4 flex items-center justify-between gap-3">
                  <div>
                    <h2 class="text-lg font-semibold text-gray-900">Connected Providers</h2>
                    <p class="text-sm text-gray-500">
                      Providers are connected on a separate page; models are managed inside each connected provider
                      here.
                    </p>
                  </div>
                </div>

                <Show
                  when={connections().length > 0}
                  fallback={
                    <div class="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-4 py-10 text-center text-sm text-gray-500">
                      <p>No provider connections yet.</p>
                      <Button as={Link} class="mt-4" to="/admin/models/add-provider">
                        Add New Provider
                      </Button>
                    </div>
                  }
                >
                  <div class="space-y-4">
                    <For each={connections()}>
                      {(connection) => {
                        return (
                          <div
                            class={`rounded-xl border p-4 transition ${
                              isSelectedConnection(connection.id)
                                ? 'border-blue-500 bg-blue-50 shadow-sm'
                                : 'border-gray-200 bg-gray-50 hover:border-gray-300 hover:bg-white'
                            }`}
                            onClick={() => {
                              loadSelectedConnection(connection)
                            }}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault()
                                loadSelectedConnection(connection)
                              }
                            }}
                            role="button"
                            tabIndex={0}
                          >
                            <div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                              <div class="space-y-2">
                                <div class="flex flex-wrap items-center gap-2">
                                  <h3 class="text-base font-semibold text-gray-900">{connection.label}</h3>
                                  <span class="rounded-full bg-white px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-gray-500">
                                    {getConnectionProviderLabel(connection.providerKind)}
                                  </span>
                                  <Show when={isSelectedConnection(connection.id)}>
                                    <span class="rounded-full bg-blue-600 px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-white">
                                      Selected
                                    </span>
                                  </Show>
                                  <span
                                    class={`rounded-full px-2 py-1 text-[11px] font-medium uppercase tracking-wide ${connection.enabled ? 'bg-green-100 text-green-700' : 'bg-gray-200 text-gray-600'}`}
                                  >
                                    {connection.enabled ? 'Enabled' : 'Disabled'}
                                  </span>
                                </div>
                                <div class="grid gap-2 text-sm text-gray-600 sm:grid-cols-2">
                                  <div>
                                    <span class="font-medium text-gray-700">Base URL:</span> {connection.baseURL ?? '-'}
                                  </div>
                                  <div>
                                    <span class="font-medium text-gray-700">Auth:</span> {connection.authMode ?? '-'}
                                  </div>
                                  <div>
                                    <span class="font-medium text-gray-700">Secret:</span>{' '}
                                    {getProviderSecretStatus(connection)}
                                  </div>
                                  <div>
                                    <span class="font-medium text-gray-700">Worker URLs:</span>{' '}
                                    {connection.workerState.effectiveWorkerUrls.length > 0
                                      ? connection.workerState.effectiveWorkerUrls.join(', ')
                                      : '-'}
                                    <span class="ml-2 text-xs text-gray-500">
                                      ({getWorkerSourceLabel(connection.workerState.workerSource)})
                                    </span>
                                  </div>
                                  <Show when={supportsRuntimeWorkerUrls(connection.providerKind)}>
                                    <div>
                                      <span class="font-medium text-gray-700">Worker mode:</span>{' '}
                                      {connection.config.workerUrlMode === 'runtime' ? 'Runtime-only' : 'Saved manual'}
                                    </div>
                                    <div>
                                      <span class="font-medium text-gray-700">Active runtime:</span>{' '}
                                      {connection.workerState.runtimeWorkerUrls.length > 0
                                        ? connection.workerState.runtimeWorkerUrls.join(', ')
                                        : 'None detected'}
                                    </div>
                                  </Show>
                                  <div>
                                    <span class="font-medium text-gray-700">Last check:</span>{' '}
                                    {formatTimestamp(connection.lastCheckedAt)}
                                  </div>
                                </div>
                                <Show when={connection.lastError}>
                                  <p class="text-sm text-red-600">{connection.lastError}</p>
                                </Show>
                              </div>

                              <div class="flex flex-wrap gap-2">
                                <button
                                  class="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-white"
                                  onClick={() => {
                                    loadSelectedConnection(connection)
                                  }}
                                  type="button"
                                >
                                  Edit
                                </button>
                                <button
                                  class="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
                                  disabled={testConnectionMutation.isPending}
                                  onClick={() => {
                                    return void runConnectionTest(connection.id)
                                  }}
                                  type="button"
                                >
                                  Test
                                </button>
                                <button
                                  class="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
                                  disabled={syncConnectionMutation.isPending}
                                  onClick={() => {
                                    return void runConnectionSync(connection.id)
                                  }}
                                  type="button"
                                >
                                  Sync Models
                                </button>
                                <button
                                  class="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
                                  disabled={updateConnectionMutation.isPending}
                                  onClick={() => {
                                    return void toggleConnectionEnabled(connection)
                                  }}
                                  type="button"
                                >
                                  {connection.enabled ? 'Disable' : 'Enable'}
                                </button>
                                <button
                                  class="rounded-md border border-red-200 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
                                  disabled={deleteConnectionMutation.isPending}
                                  onClick={() => {
                                    return void removeProviderConnection(connection)
                                  }}
                                  type="button"
                                >
                                  {deleteConnectionMutation.isPending ? 'Removing...' : 'Remove'}
                                </button>
                              </div>
                            </div>

                            <div class="mt-4 space-y-3">
                              <div class="text-xs font-semibold uppercase tracking-wide text-gray-500">Models</div>
                              <Show when={connection.models.length === 0}>
                                <div class="rounded-lg border border-dashed border-gray-300 bg-white px-4 py-6 text-sm text-gray-500">
                                  No models yet. Use sync or add one from the provider settings panel.
                                </div>
                              </Show>
                              <For each={connection.models}>
                                {(model) => {
                                  return (
                                    <form
                                      class="grid gap-3 rounded-lg border border-gray-200 bg-white p-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.9fr)_auto_auto]"
                                      onSubmit={(event) => {
                                        return void submitModelForm(event, model)
                                      }}
                                    >
                                      <div>
                                        <label class="mb-2 block text-xs font-semibold uppercase tracking-wide text-gray-500">
                                          Display Name
                                        </label>
                                        <input
                                          class="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900"
                                          name="displayName"
                                          type="text"
                                          value={model.displayName ?? model.name}
                                        />
                                        <div class="mt-2 text-xs text-gray-500">
                                          {model.remoteModelId ?? model.modelName ?? '-'} • {model.source ?? 'manual'}
                                        </div>
                                        <Show when={getProviderModelContextLength(model.metadataJson)}>
                                          <div class="mt-1 text-xs text-gray-500">
                                            Context {getProviderModelContextLength(model.metadataJson)} tokens
                                          </div>
                                        </Show>
                                        <Show when={getProviderModelDiscoverySource(model.metadataJson)}>
                                          <div class="mt-1 text-xs text-gray-500">
                                            Discovery {getProviderModelDiscoverySource(model.metadataJson)}
                                          </div>
                                        </Show>
                                        <Show when={getProviderModelReasoningEfforts(model.metadataJson).length > 0}>
                                          <div class="mt-1 text-xs text-gray-500">
                                            Reasoning {getProviderModelReasoningEfforts(model.metadataJson).join(', ')}
                                          </div>
                                        </Show>
                                      </div>
                                      <div>
                                        <label class="mb-2 block text-xs font-semibold uppercase tracking-wide text-gray-500">
                                          Variant
                                        </label>
                                        <input
                                          class="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900"
                                          name="variant"
                                          type="text"
                                          value={model.variant ?? ''}
                                        />
                                        <div class="mt-2 text-xs text-gray-500">
                                          Created {formatTimestamp(model.createdAt)}
                                        </div>
                                      </div>
                                      <label class="flex items-center gap-2 rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-700">
                                        <input checked={model.enabled} name="enabled" type="checkbox" />
                                        Enabled
                                      </label>
                                      <button
                                        class="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
                                        disabled={updateModelMutation.isPending}
                                        type="submit"
                                      >
                                        {updateModelMutation.isPending ? 'Saving...' : 'Save Model'}
                                      </button>
                                    </form>
                                  )
                                }}
                              </For>
                            </div>
                          </div>
                        )
                      }}
                    </For>
                  </div>
                </Show>
              </div>
            </div>
          </div>
        </Show>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/admin/models/' as never)({component: AdminModels})
