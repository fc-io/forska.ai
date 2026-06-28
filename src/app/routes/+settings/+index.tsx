import {createMutation, useQuery} from '@tanstack/solid-query'
import {createFileRoute} from '@tanstack/solid-router'
import {createEffect, createSignal, For, Show} from 'solid-js'

import {apiClient} from '../../../services/apiClient'
import {handleApiResponse} from '../../../services/utils/handleApiResponse'

type LocalUser = {
  maintenanceWorkerDuckdbMemoryLimit?: string | null
  codexBin?: string | null
  id: string
  name: string
  email: string
  role?: string | null
  fullTextConversionModelId?: string | null
  unpaywallEmail?: string | null
  duckdbBin?: string | null
}
type UsersResponse = {data: LocalUser[]}
type StoredModel = {
  displayName?: string | null
  enabled: boolean
  id: string
  label: string
  name: string
  provider: string
}
type MaintenanceRuntimeDiagnostics = {
  duckdb?: {configured?: {databasePath?: string | null}; effective?: {memoryLimit?: string | null}}
}
type WorkerRuntimeRegistryCapability = {
  capability: string
  eligibleConsumerCount: number
  eligibleConsumerPresent: boolean
  freshConsumerCount: number
  registeredConsumerCount: number
  staleConsumerCount: number
}
type WorkerRuntimeDiagnostics = {
  capabilities: string[]
  cutoverRefusal?: {
    refusedRegisteredProcessCount: number
    refusesMissingRuntimeVersion: boolean
    runtimeVersion: string
    status: string
  }
  duckdbOwnership?: {canOwnDuckdb: boolean; duckdbOwnerUrl: string | null; ownsDuckdb: boolean}
  localRole: string | null
  ownerlessBackends?: {validated: boolean; workerRuntimeDiagnostics: {backend: string; pathname: string} | null}
  pendingCompletionAckVisibility?: {
    available: boolean
    freshProjectionCount: number
    hasPendingCompletionAck: boolean
    jobCount: number
    pendingCompletionAckCount: number
  }
  readPath?: {judgmentJobs?: {mode: string; sharedProjectionFreshnessMs: number}}
  registry?: {
    capabilities: WorkerRuntimeRegistryCapability[]
    freshRegisteredProcessCount: number
    registeredProcessCount: number
    staleRegisteredProcessCount: number
    takeover: {status: string}
  }
  routeServing?: {duckdbOwnerPrivateApi: boolean; mode: string; ownerProxy: boolean; publicProductApi: boolean}
  serverRole: string
  takeoverState?: {status: string}
}
type RuntimeState = {
  bun: {
    maxHttpRequests: {
      configuredMaxHttpRequests: number | null
      defaultMaxHttpRequests: number
      effectiveMaxHttpRequests: number
      source: 'default' | 'env'
    }
  }
  pid: number
  role: string
  runtimeVersion: string
  serverRole: string | null
}
type RuntimeReady = {localOperatorApiExposed: boolean; ready: boolean; settingsDiagnosticsApiExposed?: boolean}
type UpdateLocalUserInput = {
  maintenanceWorkerDuckdbMemoryLimit: string
  codexBin: string
  duckdbBin: string
  email: string
  name: string
  fullTextConversionModelId: string
  unpaywallEmail: string
}
type UpdateUserResponse = {data: LocalUser}
type StoredModelsResponse = {data: StoredModel[]}
type RuntimeReadyResponse = {data: RuntimeReady}
type RuntimeStateResponse = {data: RuntimeState}
type ClearDatabasesResult = {
  clearedPaths: string[]
  duckdbPath: string
  judgmentJobsRootDirectory: string
  migrated: boolean
}
type ClearDatabasesResponse = {data: ClearDatabasesResult}

const fetchLocalUser = async (): Promise<LocalUser | null> => {
  const response = await apiClient.api.users.get()
  const result = handleApiResponse<UsersResponse>(response, 'Failed to load local user')
  return result.data?.[0] ?? null
}

const fetchStoredModels = async (): Promise<StoredModel[]> => {
  const response = await apiClient.api.models.stored.get()
  const result = handleApiResponse<StoredModelsResponse>(response, 'Failed to load stored models')

  return result.data ?? []
}

const fetchMaintenanceRuntimeDiagnostics = async (): Promise<MaintenanceRuntimeDiagnostics | null> => {
  const response = await apiClient.api.admin['maintenance-runtime-diagnostics'].get()
  return handleApiResponse<MaintenanceRuntimeDiagnostics>(response, 'Failed to load maintenance runtime diagnostics')
}

const fetchWorkerRuntimeDiagnostics = async (): Promise<WorkerRuntimeDiagnostics | null> => {
  const response = await apiClient.api.admin['worker-runtime-diagnostics'].get()
  return handleApiResponse<WorkerRuntimeDiagnostics>(response, 'Failed to load worker runtime diagnostics')
}

const fetchRuntimeReady = async (): Promise<RuntimeReady> => {
  const response = await apiClient.api.runtime.ready.get()
  const result = handleApiResponse<RuntimeReadyResponse>(response, 'Failed to load runtime readiness')
  return result.data
}

const fetchRuntimeState = async (): Promise<RuntimeState | null> => {
  const response = await apiClient.api.runtime.state.get()
  const result = handleApiResponse<RuntimeStateResponse>(response, 'Failed to load runtime state')
  return result.data
}

const SettingsDiagnosticsGateMessage = () => {
  return (
    <p class="text-xs text-amber-700">
      Settings diagnostics are not available from this backend. Restart the local server after updating to show this
      panel.
    </p>
  )
}

const getNullableString = (value: string): string | null => {
  const normalized = value.trim()

  return normalized === '' ? null : normalized
}

const formatWorkerRuntimeBoolean = (value: boolean | null | undefined) => {
  return value ? 'Yes' : 'No'
}

const formatWorkerRuntimeList = (values: string[] | null | undefined) => {
  return values && values.length > 0 ? values.join(', ') : 'None'
}

const formatRuntimeStateSource = (source: RuntimeState['bun']['maxHttpRequests']['source'] | null | undefined) => {
  return source === 'env' ? 'Env override' : 'Bun default'
}

const formatOwnerlessBackend = (diagnostics: WorkerRuntimeDiagnostics | null | undefined) => {
  const backend = diagnostics?.ownerlessBackends?.workerRuntimeDiagnostics?.backend

  return backend ?? (diagnostics?.ownerlessBackends?.validated ? 'Not selected' : 'Not validated')
}

const updateLocalUser = async (input: UpdateLocalUserInput): Promise<LocalUser> => {
  const response = await apiClient.api.users.patch({
    maintenanceWorkerDuckdbMemoryLimit: getNullableString(input.maintenanceWorkerDuckdbMemoryLimit),
    codexBin: getNullableString(input.codexBin),
    duckdbBin: getNullableString(input.duckdbBin),
    email: input.email,
    fullTextConversionModelId: getNullableString(input.fullTextConversionModelId),
    name: input.name,
    unpaywallEmail: getNullableString(input.unpaywallEmail),
  })
  const result = handleApiResponse<UpdateUserResponse>(response, 'Failed to save settings')

  return result.data
}

const clearDatabases = async (): Promise<ClearDatabasesResult> => {
  const response = await apiClient.api.admin['clear-databases'].post()
  const result = handleApiResponse<ClearDatabasesResponse>(response, 'Failed to clear databases')

  return result.data
}

const Settings = () => {
  const [maintenanceWorkerDuckdbMemoryLimit, setMaintenanceWorkerDuckdbMemoryLimit] = createSignal('')
  const [displayName, setDisplayName] = createSignal('')
  const [profileEmail, setProfileEmail] = createSignal('')
  const [fullTextConversionModelId, setFullTextConversionModelId] = createSignal('')
  const [unpaywallEmail, setUnpaywallEmail] = createSignal('')
  const [duckdbBin, setDuckdbBin] = createSignal('')
  const [codexBin, setCodexBin] = createSignal('')
  const localUserQuery = useQuery(() => {
    return {queryKey: ['local-user'], queryFn: fetchLocalUser, staleTime: 5 * 60 * 1000, refetchOnWindowFocus: false}
  })
  const storedModelsQuery = useQuery(() => {
    return {
      queryKey: ['stored-models'],
      queryFn: fetchStoredModels,
      staleTime: 5 * 60 * 1000,
      refetchOnWindowFocus: false,
    }
  })
  const runtimeReadyQuery = useQuery(() => {
    return {
      queryKey: ['runtime-ready'],
      queryFn: fetchRuntimeReady,
      staleTime: 60_000,
      refetchInterval: 15_000,
      refetchOnWindowFocus: false,
    }
  })
  const canLoadSettingsDiagnostics = () => {
    return runtimeReadyQuery.data?.settingsDiagnosticsApiExposed !== false
  }
  const shouldShowSettingsDiagnosticsGateMessage = () => {
    return !runtimeReadyQuery.isLoading && !canLoadSettingsDiagnostics()
  }
  const maintenanceRuntimeDiagnosticsQuery = useQuery(() => {
    return {
      queryKey: ['maintenance-runtime-diagnostics'],
      queryFn: fetchMaintenanceRuntimeDiagnostics,
      enabled: canLoadSettingsDiagnostics(),
      staleTime: 1_000,
      refetchInterval: 5_000,
      refetchOnWindowFocus: false,
    }
  })
  const workerRuntimeDiagnosticsQuery = useQuery(() => {
    return {
      queryKey: ['worker-runtime-diagnostics'],
      queryFn: fetchWorkerRuntimeDiagnostics,
      enabled: canLoadSettingsDiagnostics(),
      staleTime: 1_000,
      refetchInterval: 5_000,
      refetchOnWindowFocus: false,
    }
  })
  const runtimeStateQuery = useQuery(() => {
    return {
      queryKey: ['runtime-state'],
      queryFn: fetchRuntimeState,
      enabled: canLoadSettingsDiagnostics(),
      staleTime: 60_000,
      refetchOnWindowFocus: false,
    }
  })
  const updateLocalUserMutation = createMutation(() => {
    return {
      mutationFn: updateLocalUser,
      onSuccess: (user: LocalUser) => {
        setMaintenanceWorkerDuckdbMemoryLimit(user.maintenanceWorkerDuckdbMemoryLimit ?? '')
        setDisplayName(user.name)
        setProfileEmail(user.email)
        setFullTextConversionModelId(user.fullTextConversionModelId ?? '')
        setUnpaywallEmail(user.unpaywallEmail ?? '')
        setDuckdbBin(user.duckdbBin ?? '')
        setCodexBin(user.codexBin ?? '')
        void localUserQuery.refetch()
        if (canLoadSettingsDiagnostics()) {
          void maintenanceRuntimeDiagnosticsQuery.refetch()
          void workerRuntimeDiagnosticsQuery.refetch()
        }
      },
    }
  })
  const clearDatabasesMutation = createMutation(() => {
    return {
      mutationFn: clearDatabases,
      onSuccess: () => {
        void localUserQuery.refetch()
        void storedModelsQuery.refetch()
        void maintenanceRuntimeDiagnosticsQuery.refetch()
        void workerRuntimeDiagnosticsQuery.refetch()
        void runtimeStateQuery.refetch()
      },
    }
  })

  createEffect(() => {
    setMaintenanceWorkerDuckdbMemoryLimit(localUserQuery.data?.maintenanceWorkerDuckdbMemoryLimit ?? '')
    setDisplayName(localUserQuery.data?.name ?? '')
    setProfileEmail(localUserQuery.data?.email ?? '')
    setFullTextConversionModelId(localUserQuery.data?.fullTextConversionModelId ?? '')
    setUnpaywallEmail(localUserQuery.data?.unpaywallEmail ?? '')
    setDuckdbBin(localUserQuery.data?.duckdbBin ?? '')
    setCodexBin(localUserQuery.data?.codexBin ?? '')
  })

  const fullTextConversionModels = () => {
    return (storedModelsQuery.data ?? []).filter((model) => {
      return model.enabled && model.provider === 'docling'
    })
  }

  const isProfileDirty = () => {
    return (
      displayName().trim() !== (localUserQuery.data?.name ?? '').trim()
      || profileEmail().trim() !== (localUserQuery.data?.email ?? '').trim()
      || fullTextConversionModelId().trim() !== (localUserQuery.data?.fullTextConversionModelId ?? '').trim()
      || maintenanceWorkerDuckdbMemoryLimit().trim()
        !== (localUserQuery.data?.maintenanceWorkerDuckdbMemoryLimit ?? '').trim()
      || unpaywallEmail().trim() !== (localUserQuery.data?.unpaywallEmail ?? '').trim()
      || duckdbBin().trim() !== (localUserQuery.data?.duckdbBin ?? '').trim()
      || codexBin().trim() !== (localUserQuery.data?.codexBin ?? '').trim()
    )
  }

  return (
    <div class="p-6 max-w-4xl mx-auto">
      <h1 class="text-3xl font-bold mb-6">Settings</h1>

      <div class="space-y-6">
        <div class="bg-white border border-gray-200 rounded-lg shadow-sm p-6">
          <h2 class="text-xl font-semibold text-gray-900 mb-4">Local profile</h2>
          <Show when={localUserQuery.isLoading}>
            <p class="text-sm text-gray-600">Loading local profile...</p>
          </Show>
          <Show when={localUserQuery.isError}>
            <p class="text-sm text-red-600">
              {localUserQuery.error instanceof Error ? localUserQuery.error.message : 'Failed to load local profile'}
            </p>
          </Show>
          <Show when={!localUserQuery.isLoading && !localUserQuery.isError}>
            <div class="space-y-4">
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-2">Email</label>
                <input
                  type="email"
                  value={profileEmail()}
                  onInput={(event) => {
                    setProfileEmail(event.currentTarget.value)
                  }}
                  class="w-full px-3 py-3 border border-gray-300 rounded-md bg-white text-gray-900"
                />
              </div>
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-2">Display Name</label>
                <input
                  type="text"
                  value={displayName()}
                  onInput={(event) => {
                    setDisplayName(event.currentTarget.value)
                  }}
                  class="w-full px-3 py-3 border border-gray-300 rounded-md bg-white text-gray-900 sm:text-sm"
                />
              </div>
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-2">PDF Conversion Model</label>
                <select
                  value={fullTextConversionModelId()}
                  onInput={(event) => {
                    setFullTextConversionModelId(event.currentTarget.value)
                  }}
                  class="w-full px-3 py-3 border border-gray-300 rounded-md bg-white text-gray-900 sm:text-sm"
                >
                  <option value="">No PDF conversion model selected</option>
                  <For each={fullTextConversionModels()}>
                    {(model) => {
                      return <option value={model.id}>{model.label}</option>
                    }}
                  </For>
                </select>
                <p class="mt-2 text-xs text-gray-500">
                  Choose a Docling provider model for PDF conversion. Manage endpoints and models on the Providers page.
                </p>
              </div>
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-2">Unpaywall Email</label>
                <input
                  type="email"
                  value={unpaywallEmail()}
                  onInput={(event) => {
                    setUnpaywallEmail(event.currentTarget.value)
                  }}
                  class="w-full px-3 py-3 border border-gray-300 rounded-md bg-white text-gray-900 sm:text-sm"
                />
                <p class="mt-2 text-xs text-gray-500">
                  Used when fetching PDFs from Unpaywall. Stored in local app config.
                </p>
              </div>
              <div class="pt-2 border-t border-gray-200">
                <h3 class="text-sm font-semibold text-gray-900 mb-3">Maintenance runtime</h3>
                <div class="space-y-4">
                  <div>
                    <label class="block text-sm font-medium text-gray-700 mb-2">
                      Maintenance DuckDB Memory Limit (restart required)
                    </label>
                    <input
                      type="text"
                      value={maintenanceWorkerDuckdbMemoryLimit()}
                      onInput={(event) => {
                        setMaintenanceWorkerDuckdbMemoryLimit(event.currentTarget.value)
                      }}
                      class="w-full px-3 py-3 border border-gray-300 rounded-md bg-white text-gray-900 sm:text-sm"
                      placeholder="20GB"
                    />
                    <p class="mt-2 text-xs text-gray-500">
                      Optional machine-local override for the maintenance DuckDB memory cap. Leave empty to use the
                      automatic memory limit from your host RAM. DuckDB memory-limit changes require a server restart to
                      take effect.
                    </p>
                  </div>
                  <div class="rounded-md border border-gray-200 bg-gray-50 p-4 space-y-2">
                    <p class="text-sm font-medium text-gray-900">Maintenance diagnostics</p>
                    <Show when={runtimeReadyQuery.isLoading && !canLoadSettingsDiagnostics()}>
                      <p class="text-xs text-gray-500">Checking Settings diagnostics access...</p>
                    </Show>
                    <Show when={shouldShowSettingsDiagnosticsGateMessage()}>
                      <SettingsDiagnosticsGateMessage />
                    </Show>
                    <Show when={canLoadSettingsDiagnostics() && maintenanceRuntimeDiagnosticsQuery.isLoading}>
                      <p class="text-xs text-gray-500">Loading maintenance runtime diagnostics...</p>
                    </Show>
                    <Show when={canLoadSettingsDiagnostics() && maintenanceRuntimeDiagnosticsQuery.isError}>
                      <p class="text-xs text-red-600">
                        {maintenanceRuntimeDiagnosticsQuery.error instanceof Error
                          ? maintenanceRuntimeDiagnosticsQuery.error.message
                          : 'Failed to load maintenance runtime diagnostics'}
                      </p>
                    </Show>
                    <Show
                      when={
                        canLoadSettingsDiagnostics()
                        && !maintenanceRuntimeDiagnosticsQuery.isLoading
                        && !maintenanceRuntimeDiagnosticsQuery.isError
                      }
                    >
                      <p class="text-xs text-gray-600">
                        DuckDB path:{' '}
                        <span class="font-mono break-all">
                          {maintenanceRuntimeDiagnosticsQuery.data?.duckdb?.configured?.databasePath ?? 'N/A'}
                        </span>
                      </p>
                      <p class="text-xs text-gray-600">
                        Maintenance memory:{' '}
                        {maintenanceRuntimeDiagnosticsQuery.data?.duckdb?.effective?.memoryLimit ?? 'N/A'}
                      </p>
                    </Show>
                    <p class="text-xs text-gray-500">
                      DuckDB memory-limit changes are saved immediately but only apply after the next server restart.
                    </p>
                  </div>
                  <div class="rounded-md border border-gray-200 bg-gray-50 p-4 space-y-2">
                    <p class="text-sm font-medium text-gray-900">Runtime state</p>
                    <Show when={runtimeReadyQuery.isLoading && !canLoadSettingsDiagnostics()}>
                      <p class="text-xs text-gray-500">Checking Settings diagnostics access...</p>
                    </Show>
                    <Show when={shouldShowSettingsDiagnosticsGateMessage()}>
                      <SettingsDiagnosticsGateMessage />
                    </Show>
                    <Show when={canLoadSettingsDiagnostics() && runtimeStateQuery.isLoading}>
                      <p class="text-xs text-gray-500">Loading runtime state...</p>
                    </Show>
                    <Show when={canLoadSettingsDiagnostics() && runtimeStateQuery.isError}>
                      <p class="text-xs text-red-600">
                        {runtimeStateQuery.error instanceof Error
                          ? runtimeStateQuery.error.message
                          : 'Failed to load runtime state'}
                      </p>
                    </Show>
                    <Show
                      when={canLoadSettingsDiagnostics() && !runtimeStateQuery.isLoading && !runtimeStateQuery.isError}
                    >
                      <p class="text-xs text-gray-600">
                        Bun max HTTP requests:{' '}
                        {runtimeStateQuery.data?.bun.maxHttpRequests.effectiveMaxHttpRequests ?? 'N/A'} (
                        {formatRuntimeStateSource(runtimeStateQuery.data?.bun.maxHttpRequests.source)})
                      </p>
                      <p class="text-xs text-gray-600">
                        Configured env:{' '}
                        {runtimeStateQuery.data?.bun.maxHttpRequests.configuredMaxHttpRequests ?? 'not set'} | Bun
                        default: {runtimeStateQuery.data?.bun.maxHttpRequests.defaultMaxHttpRequests ?? 'N/A'}
                      </p>
                      <p class="text-xs text-gray-600">
                        Process: role {runtimeStateQuery.data?.role ?? 'N/A'} | configured role{' '}
                        {runtimeStateQuery.data?.serverRole ?? 'N/A'} | pid {runtimeStateQuery.data?.pid ?? 'N/A'}
                      </p>
                    </Show>
                  </div>
                  <div class="rounded-md border border-gray-200 bg-gray-50 p-4 space-y-3">
                    <p class="text-sm font-medium text-gray-900">Worker runtime diagnostics</p>
                    <Show when={runtimeReadyQuery.isLoading && !canLoadSettingsDiagnostics()}>
                      <p class="text-xs text-gray-500">Checking Settings diagnostics access...</p>
                    </Show>
                    <Show when={shouldShowSettingsDiagnosticsGateMessage()}>
                      <SettingsDiagnosticsGateMessage />
                    </Show>
                    <Show when={canLoadSettingsDiagnostics() && workerRuntimeDiagnosticsQuery.isLoading}>
                      <p class="text-xs text-gray-500">Loading worker runtime diagnostics...</p>
                    </Show>
                    <Show when={canLoadSettingsDiagnostics() && workerRuntimeDiagnosticsQuery.isError}>
                      <p class="text-xs text-red-600">
                        {workerRuntimeDiagnosticsQuery.error instanceof Error
                          ? workerRuntimeDiagnosticsQuery.error.message
                          : 'Failed to load worker runtime diagnostics'}
                      </p>
                    </Show>
                    <Show
                      when={
                        canLoadSettingsDiagnostics()
                        && !workerRuntimeDiagnosticsQuery.isLoading
                        && !workerRuntimeDiagnosticsQuery.isError
                      }
                    >
                      <div class="grid gap-2 md:grid-cols-2">
                        <p class="text-xs text-gray-600">
                          Local role: {workerRuntimeDiagnosticsQuery.data?.localRole ?? 'N/A'} | Server role:{' '}
                          {workerRuntimeDiagnosticsQuery.data?.serverRole ?? 'N/A'}
                        </p>
                        <p class="text-xs text-gray-600">
                          Capabilities: {formatWorkerRuntimeList(workerRuntimeDiagnosticsQuery.data?.capabilities)}
                        </p>
                        <p class="text-xs text-gray-600">
                          Route mode: {workerRuntimeDiagnosticsQuery.data?.routeServing?.mode ?? 'N/A'} | Owner proxy:{' '}
                          {formatWorkerRuntimeBoolean(workerRuntimeDiagnosticsQuery.data?.routeServing?.ownerProxy)}
                        </p>
                        <p class="text-xs text-gray-600">
                          DuckDB owner:{' '}
                          {formatWorkerRuntimeBoolean(workerRuntimeDiagnosticsQuery.data?.duckdbOwnership?.ownsDuckdb)}{' '}
                          | Owner URL: {workerRuntimeDiagnosticsQuery.data?.duckdbOwnership?.duckdbOwnerUrl ?? 'N/A'}
                        </p>
                        <p class="text-xs text-gray-600">
                          Ownerless backend: {formatOwnerlessBackend(workerRuntimeDiagnosticsQuery.data)}
                        </p>
                        <p class="text-xs text-gray-600">
                          Read path: {workerRuntimeDiagnosticsQuery.data?.readPath?.judgmentJobs?.mode ?? 'N/A'} |
                          Pending completion acks:{' '}
                          {workerRuntimeDiagnosticsQuery.data?.pendingCompletionAckVisibility?.available
                            ? workerRuntimeDiagnosticsQuery.data.pendingCompletionAckVisibility
                                .pendingCompletionAckCount
                            : 'N/A'}
                        </p>
                        <p class="text-xs text-gray-600">
                          Registry processes:{' '}
                          {workerRuntimeDiagnosticsQuery.data?.registry?.freshRegisteredProcessCount ?? 0} fresh /{' '}
                          {workerRuntimeDiagnosticsQuery.data?.registry?.registeredProcessCount ?? 0} total
                        </p>
                        <p class="text-xs text-gray-600">
                          Takeover: {workerRuntimeDiagnosticsQuery.data?.takeoverState?.status ?? 'N/A'} | Cutover:{' '}
                          {workerRuntimeDiagnosticsQuery.data?.cutoverRefusal?.status ?? 'N/A'}
                        </p>
                      </div>
                      <div class="overflow-x-auto">
                        <table class="min-w-full text-left text-xs text-gray-600">
                          <thead class="text-gray-500">
                            <tr>
                              <th class="py-2 pr-3 font-medium">Capability</th>
                              <th class="py-2 pr-3 font-medium">Eligible</th>
                              <th class="py-2 pr-3 font-medium">Fresh</th>
                              <th class="py-2 pr-3 font-medium">Stale</th>
                            </tr>
                          </thead>
                          <tbody class="divide-y divide-gray-200">
                            <For each={workerRuntimeDiagnosticsQuery.data?.registry?.capabilities ?? []}>
                              {(capability) => {
                                return (
                                  <tr>
                                    <td class="py-2 pr-3 font-medium text-gray-700">{capability.capability}</td>
                                    <td class="py-2 pr-3">
                                      {capability.eligibleConsumerCount} / {capability.registeredConsumerCount}
                                    </td>
                                    <td class="py-2 pr-3">{capability.freshConsumerCount}</td>
                                    <td class="py-2 pr-3">{capability.staleConsumerCount}</td>
                                  </tr>
                                )
                              }}
                            </For>
                          </tbody>
                        </table>
                      </div>
                    </Show>
                  </div>
                </div>
              </div>
              <div class="pt-2 border-t border-gray-200">
                <h3 class="text-sm font-semibold text-gray-900 mb-3">Advanced</h3>
                <div class="space-y-4">
                  <div>
                    <label class="block text-sm font-medium text-gray-700 mb-2">DuckDB Binary</label>
                    <input
                      type="text"
                      value={duckdbBin()}
                      onInput={(event) => {
                        setDuckdbBin(event.currentTarget.value)
                      }}
                      class="w-full px-3 py-3 border border-gray-300 rounded-md bg-white text-gray-900 sm:text-sm"
                    />
                    <p class="mt-2 text-xs text-gray-500">
                      Optional override for the DuckDB CLI binary. Leave empty to use `duckdb` on PATH.
                    </p>
                  </div>
                  <div>
                    <label class="block text-sm font-medium text-gray-700 mb-2">Codex Binary</label>
                    <input
                      type="text"
                      value={codexBin()}
                      onInput={(event) => {
                        setCodexBin(event.currentTarget.value)
                      }}
                      class="w-full px-3 py-3 border border-gray-300 rounded-md bg-white text-gray-900 sm:text-sm"
                    />
                    <p class="mt-2 text-xs text-gray-500">
                      Optional override for the Codex CLI binary. Leave empty to auto-detect it.
                    </p>
                  </div>
                  <p class="text-xs text-gray-500">Binary changes apply on the next server restart.</p>
                </div>
              </div>
              <div class="pt-2 border-t border-red-200">
                <h3 class="text-sm font-semibold text-red-900 mb-3">Danger zone</h3>
                <div class="rounded-md border border-red-200 bg-red-50 p-4 space-y-3">
                  <div>
                    <p class="text-sm font-medium text-red-900">Clear local databases</p>
                    <p class="mt-1 text-xs text-red-700">
                      Deletes the local DuckDB database and judgment job SQLite databases, then reruns DuckDB
                      migrations. This cannot be undone.
                    </p>
                  </div>
                  <Show when={clearDatabasesMutation.isError}>
                    <p class="text-sm text-red-700">
                      {clearDatabasesMutation.error instanceof Error
                        ? clearDatabasesMutation.error.message
                        : 'Failed to clear databases'}
                    </p>
                  </Show>
                  <Show when={clearDatabasesMutation.isSuccess}>
                    <p class="text-sm text-green-700">Databases cleared and migrations rerun.</p>
                  </Show>
                  <button
                    class="w-full sm:w-auto px-4 py-3 bg-red-600 text-white rounded-md shadow-sm hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 text-sm font-medium disabled:opacity-60 disabled:cursor-not-allowed"
                    disabled={clearDatabasesMutation.isPending}
                    onClick={() => {
                      if (
                        globalThis.confirm(
                          'Clear all local databases? This deletes local projects, articles, judgments, jobs, and database-backed settings.',
                        )
                      ) {
                        clearDatabasesMutation.mutate()
                      }
                    }}
                  >
                    {clearDatabasesMutation.isPending ? 'Clearing...' : 'Clear Databases'}
                  </button>
                </div>
              </div>
              <Show when={updateLocalUserMutation.isError}>
                <p class="text-sm text-red-600">
                  {updateLocalUserMutation.error instanceof Error
                    ? updateLocalUserMutation.error.message
                    : 'Failed to save profile'}
                </p>
              </Show>
              <Show when={updateLocalUserMutation.isSuccess && !isProfileDirty()}>
                <p class="text-sm text-green-700">Saved.</p>
              </Show>
              <button
                class="w-full sm:w-auto px-4 py-3 bg-blue-600 text-white rounded-md shadow-sm hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 text-sm font-medium disabled:opacity-60 disabled:cursor-not-allowed"
                disabled={updateLocalUserMutation.isPending || !isProfileDirty()}
                onClick={() => {
                  updateLocalUserMutation.mutate({
                    maintenanceWorkerDuckdbMemoryLimit: maintenanceWorkerDuckdbMemoryLimit(),
                    codexBin: codexBin(),
                    duckdbBin: duckdbBin(),
                    email: profileEmail(),
                    fullTextConversionModelId: fullTextConversionModelId(),
                    name: displayName(),
                    unpaywallEmail: unpaywallEmail(),
                  })
                }}
              >
                {updateLocalUserMutation.isPending ? 'Saving...' : 'Save Settings'}
              </button>
            </div>
          </Show>
        </div>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/settings/')({component: Settings})
