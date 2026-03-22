import {createMutation, useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {createSignal, For, Show} from 'solid-js'

import {Button} from '../../../components/ui/button.tsx'
import {
  deleteProviderConnection,
  fetchProviderConnections,
  formatTimestamp,
  getProviderCatalogLabel,
  getProviderSecretStatus,
  getWorkerSourceLabel,
  type ProviderConnection,
  supportsRuntimeWorkerUrls,
  syncProviderConnectionModels,
  testProviderConnectionApi,
  updateProviderConnection,
} from '../+admin/+models/providerConnectionsClient.ts'

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
  const [pageMessage, setPageMessage] = createSignal('')
  const [pageError, setPageError] = createSignal('')

  const updateConnectionMutation = createMutation(() => {
    return {
      mutationFn: updateProviderConnection,
      onSuccess: async (connection: ProviderConnection) => {
        setPageError('')
        setPageMessage(`Updated ${connection.label}`)
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

  const getConnectionProviderLabel = (providerKind: string) => {
    return getProviderCatalogLabel(catalog(), providerKind)
  }

  const supportsConnectionDiscovery = (connection: ProviderConnection) => {
    return Boolean(
      catalog().find((entry) => {
        return entry.kind === connection.providerKind
      })?.supportsDiscovery,
    )
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

  return (
    <div class="min-h-screen bg-gray-50 p-6">
      <div class="mx-auto max-w-7xl space-y-6">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 class="text-2xl font-bold text-gray-900">Provider</h1>
            <p class="text-sm text-gray-500">
              Add providers on a separate page, then open each provider to manage settings and enable or disable its
              models.
            </p>
          </div>
          <Button as={Link} to="/providers/add-provider">
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
          <div class="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
            <div class="mb-4 flex items-center justify-between gap-3">
              <div>
                <h2 class="text-lg font-semibold text-gray-900">Connected Providers</h2>
                <p class="text-sm text-gray-500">Open a provider to update its settings and manage its models.</p>
              </div>
            </div>

            <Show
              when={connections().length > 0}
              fallback={
                <div class="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-4 py-10 text-center text-sm text-gray-500">
                  <p>No provider connections yet.</p>
                  <Button as={Link} class="mt-4" to="/providers/add-provider">
                    Add New Provider
                  </Button>
                </div>
              }
            >
              <div class="space-y-4">
                <For each={connections()}>
                  {(connection) => {
                    return (
                      <div class="rounded-xl border border-gray-200 bg-gray-50 p-4">
                        <div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                          <div class="space-y-2">
                            <div class="flex flex-wrap items-center gap-2">
                              <h3 class="text-base font-semibold text-gray-900">{connection.label}</h3>
                              <span class="rounded-full bg-white px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-gray-500">
                                {getConnectionProviderLabel(connection.providerKind)}
                              </span>
                              <span
                                class={`rounded-full px-2 py-1 text-[11px] font-medium uppercase tracking-wide ${connection.enabled ? 'bg-green-100 text-green-700' : 'bg-gray-200 text-gray-600'}`}
                              >
                                {connection.enabled ? 'Enabled' : 'Disabled'}
                              </span>
                            </div>
                            <div class="grid gap-2 text-sm text-gray-600 sm:grid-cols-2 xl:grid-cols-3">
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
                              <div>
                                <span class="font-medium text-gray-700">Last check:</span>{' '}
                                {formatTimestamp(connection.lastCheckedAt)}
                              </div>
                              <Show when={supportsRuntimeWorkerUrls(connection.providerKind)}>
                                <div>
                                  <span class="font-medium text-gray-700">Worker mode:</span>{' '}
                                  {connection.config.workerUrlMode === 'runtime' ? 'Runtime-only' : 'Saved manual'}
                                </div>
                              </Show>
                            </div>
                            <Show when={connection.lastError}>
                              <p class="text-sm text-red-600">{connection.lastError}</p>
                            </Show>
                          </div>

                          <div class="flex flex-wrap gap-2">
                            <Button
                              as={Link}
                              params={{id: connection.id} as never}
                              to="/providers/$id"
                              variant="outline"
                            >
                              Open Provider
                            </Button>
                            <button
                              class="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
                              disabled={testConnectionMutation.isPending}
                              onClick={() => {
                                return void runConnectionTest(connection.id)
                              }}
                              type="button"
                            >
                              {testConnectionMutation.isPending ? 'Testing...' : 'Test'}
                            </button>
                            <button
                              class="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
                              disabled={syncConnectionMutation.isPending || !supportsConnectionDiscovery(connection)}
                              onClick={() => {
                                return void runConnectionSync(connection.id)
                              }}
                              type="button"
                            >
                              {syncConnectionMutation.isPending ? 'Syncing...' : 'Sync Models'}
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
                      </div>
                    )
                  }}
                </For>
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/providers/' as never)({component: AdminModels})
