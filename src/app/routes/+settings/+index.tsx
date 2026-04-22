import {createMutation, useQuery} from '@tanstack/solid-query'
import {createFileRoute} from '@tanstack/solid-router'
import {createEffect, createSignal, For, Show} from 'solid-js'

import {apiClient} from '../../../services/apiClient'
import {handleApiResponse} from '../../../services/utils/handleApiResponse'

type ProjectMartLargeRebuildTuningMode = 'automatic' | 'manual'
type LocalUser = {
  backgroundWriterDuckdbMemoryLimit?: string | null
  codexBin?: string | null
  id: string
  name: string
  email: string
  role?: string | null
  fullTextConversionModelId?: string | null
  projectMartLargeRebuildBatchSize?: number | null
  projectMartLargeRebuildMaxCyclesPerWake?: number | null
  projectMartLargeRebuildPollIntervalMs?: number | null
  projectMartLargeRebuildTuningMode?: ProjectMartLargeRebuildTuningMode | null
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
  duckdb?: {effective?: {memoryLimit?: string | null}}
  projectMartLargeRebuildHeartbeat?: {
    automatic?: {
      activeLargeRebuildProjectCount?: number
      batchSize?: number
      maxCyclesPerWake?: number
      pollIntervalMs?: number
      profile?: string
      totalMemoryGb?: number
    }
    batchSize?: number
    maxCyclesPerWake?: number
    pollIntervalMs?: number
    sources?: {batchSize?: string; maxCyclesPerWake?: string; pollIntervalMs?: string}
    stored?: {
      backgroundWriterDuckdbMemoryLimit?: string | null
      batchSize?: number | null
      maxCyclesPerWake?: number | null
      pollIntervalMs?: number | null
      tuningMode?: ProjectMartLargeRebuildTuningMode
    }
  }
}
type UpdateLocalUserInput = {
  backgroundWriterDuckdbMemoryLimit: string
  codexBin: string
  duckdbBin: string
  email: string
  name: string
  fullTextConversionModelId: string
  projectMartLargeRebuildBatchSize: string
  projectMartLargeRebuildMaxCyclesPerWake: string
  projectMartLargeRebuildPollIntervalMs: string
  projectMartLargeRebuildTuningMode: ProjectMartLargeRebuildTuningMode
  unpaywallEmail: string
}
type UpdateUserResponse = {data: LocalUser}
type StoredModelsResponse = {data: StoredModel[]}

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

const getNullableString = (value: string): string | null => {
  const normalized = value.trim()

  return normalized === '' ? null : normalized
}

const getNullablePositiveInteger = (value: string): number | null => {
  const normalized = value.trim()
  const parsed = Number.parseInt(normalized, 10)

  return normalized !== '' && Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

const formatTuningSource = (value: string | null | undefined) => {
  if (value === 'env') return 'Env override'
  if (value === 'manual') return 'Manual setting'
  return 'Automatic'
}

const formatTuningSummary = (value: {
  batchSize?: number | null
  maxCyclesPerWake?: number | null
  pollIntervalMs?: number | null
}) => {
  return value.batchSize && value.maxCyclesPerWake && value.pollIntervalMs
    ? `batch ${value.batchSize}, poll ${value.pollIntervalMs}ms, burst ${value.maxCyclesPerWake}`
    : 'N/A'
}

const updateLocalUser = async (input: UpdateLocalUserInput): Promise<LocalUser> => {
  const response = await apiClient.api.users.patch({
    backgroundWriterDuckdbMemoryLimit: getNullableString(input.backgroundWriterDuckdbMemoryLimit),
    codexBin: getNullableString(input.codexBin),
    duckdbBin: getNullableString(input.duckdbBin),
    email: input.email,
    fullTextConversionModelId: getNullableString(input.fullTextConversionModelId),
    name: input.name,
    projectMartLargeRebuildBatchSize: getNullablePositiveInteger(input.projectMartLargeRebuildBatchSize),
    projectMartLargeRebuildMaxCyclesPerWake: getNullablePositiveInteger(input.projectMartLargeRebuildMaxCyclesPerWake),
    projectMartLargeRebuildPollIntervalMs: getNullablePositiveInteger(input.projectMartLargeRebuildPollIntervalMs),
    projectMartLargeRebuildTuningMode: input.projectMartLargeRebuildTuningMode,
    unpaywallEmail: getNullableString(input.unpaywallEmail),
  })
  const result = handleApiResponse<UpdateUserResponse>(response, 'Failed to save settings')

  return result.data
}

const Settings = () => {
  const [backgroundWriterDuckdbMemoryLimit, setBackgroundWriterDuckdbMemoryLimit] = createSignal('')
  const [displayName, setDisplayName] = createSignal('')
  const [profileEmail, setProfileEmail] = createSignal('')
  const [fullTextConversionModelId, setFullTextConversionModelId] = createSignal('')
  const [projectMartLargeRebuildBatchSize, setProjectMartLargeRebuildBatchSize] = createSignal('')
  const [projectMartLargeRebuildMaxCyclesPerWake, setProjectMartLargeRebuildMaxCyclesPerWake] = createSignal('')
  const [projectMartLargeRebuildPollIntervalMs, setProjectMartLargeRebuildPollIntervalMs] = createSignal('')
  const [projectMartLargeRebuildTuningMode, setProjectMartLargeRebuildTuningMode] =
    createSignal<ProjectMartLargeRebuildTuningMode>('automatic')
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
  const maintenanceRuntimeDiagnosticsQuery = useQuery(() => {
    return {
      queryKey: ['maintenance-runtime-diagnostics'],
      queryFn: fetchMaintenanceRuntimeDiagnostics,
      staleTime: 1_000,
      refetchInterval: 5_000,
      refetchOnWindowFocus: false,
    }
  })
  const updateLocalUserMutation = createMutation(() => {
    return {
      mutationFn: updateLocalUser,
      onSuccess: (user: LocalUser) => {
        setBackgroundWriterDuckdbMemoryLimit(user.backgroundWriterDuckdbMemoryLimit ?? '')
        setDisplayName(user.name)
        setProfileEmail(user.email)
        setFullTextConversionModelId(user.fullTextConversionModelId ?? '')
        setProjectMartLargeRebuildBatchSize(String(user.projectMartLargeRebuildBatchSize ?? ''))
        setProjectMartLargeRebuildMaxCyclesPerWake(String(user.projectMartLargeRebuildMaxCyclesPerWake ?? ''))
        setProjectMartLargeRebuildPollIntervalMs(String(user.projectMartLargeRebuildPollIntervalMs ?? ''))
        setProjectMartLargeRebuildTuningMode(user.projectMartLargeRebuildTuningMode ?? 'automatic')
        setUnpaywallEmail(user.unpaywallEmail ?? '')
        setDuckdbBin(user.duckdbBin ?? '')
        setCodexBin(user.codexBin ?? '')
        void localUserQuery.refetch()
        void maintenanceRuntimeDiagnosticsQuery.refetch()
      },
    }
  })

  createEffect(() => {
    setBackgroundWriterDuckdbMemoryLimit(localUserQuery.data?.backgroundWriterDuckdbMemoryLimit ?? '')
    setDisplayName(localUserQuery.data?.name ?? '')
    setProfileEmail(localUserQuery.data?.email ?? '')
    setFullTextConversionModelId(localUserQuery.data?.fullTextConversionModelId ?? '')
    setProjectMartLargeRebuildBatchSize(String(localUserQuery.data?.projectMartLargeRebuildBatchSize ?? ''))
    setProjectMartLargeRebuildMaxCyclesPerWake(
      String(localUserQuery.data?.projectMartLargeRebuildMaxCyclesPerWake ?? ''),
    )
    setProjectMartLargeRebuildPollIntervalMs(String(localUserQuery.data?.projectMartLargeRebuildPollIntervalMs ?? ''))
    setProjectMartLargeRebuildTuningMode(localUserQuery.data?.projectMartLargeRebuildTuningMode ?? 'automatic')
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
      || projectMartLargeRebuildTuningMode() !== (localUserQuery.data?.projectMartLargeRebuildTuningMode ?? 'automatic')
      || projectMartLargeRebuildBatchSize().trim()
        !== String(localUserQuery.data?.projectMartLargeRebuildBatchSize ?? '').trim()
      || projectMartLargeRebuildMaxCyclesPerWake().trim()
        !== String(localUserQuery.data?.projectMartLargeRebuildMaxCyclesPerWake ?? '').trim()
      || projectMartLargeRebuildPollIntervalMs().trim()
        !== String(localUserQuery.data?.projectMartLargeRebuildPollIntervalMs ?? '').trim()
      || backgroundWriterDuckdbMemoryLimit().trim()
        !== (localUserQuery.data?.backgroundWriterDuckdbMemoryLimit ?? '').trim()
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
                <h3 class="text-sm font-semibold text-gray-900 mb-3">Background rebuild tuning</h3>
                <div class="space-y-4">
                  <div>
                    <label class="block text-sm font-medium text-gray-700 mb-2">Tuning mode</label>
                    <select
                      value={projectMartLargeRebuildTuningMode()}
                      onInput={(event) => {
                        setProjectMartLargeRebuildTuningMode(
                          event.currentTarget.value as ProjectMartLargeRebuildTuningMode,
                        )
                      }}
                      class="w-full px-3 py-3 border border-gray-300 rounded-md bg-white text-gray-900 sm:text-sm"
                    >
                      <option value="automatic">Automatic</option>
                      <option value="manual">Manual</option>
                    </select>
                    <p class="mt-2 text-xs text-gray-500">
                      Automatic mode tunes the rebuild heartbeat from machine memory and active rebuild count. Manual
                      mode lets you pin batch size, poll interval, and burst size.
                    </p>
                  </div>
                  <div>
                    <label class="block text-sm font-medium text-gray-700 mb-2">
                      Maintenance DuckDB Memory Limit (restart required)
                    </label>
                    <input
                      type="text"
                      value={backgroundWriterDuckdbMemoryLimit()}
                      onInput={(event) => {
                        setBackgroundWriterDuckdbMemoryLimit(event.currentTarget.value)
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
                  <Show when={projectMartLargeRebuildTuningMode() === 'manual'}>
                    <div class="grid gap-4 md:grid-cols-3">
                      <div>
                        <label class="block text-sm font-medium text-gray-700 mb-2">Batch Size</label>
                        <input
                          type="number"
                          min="1"
                          value={projectMartLargeRebuildBatchSize()}
                          onInput={(event) => {
                            setProjectMartLargeRebuildBatchSize(event.currentTarget.value)
                          }}
                          class="w-full px-3 py-3 border border-gray-300 rounded-md bg-white text-gray-900 sm:text-sm"
                        />
                      </div>
                      <div>
                        <label class="block text-sm font-medium text-gray-700 mb-2">Poll Interval (ms)</label>
                        <input
                          type="number"
                          min="1"
                          value={projectMartLargeRebuildPollIntervalMs()}
                          onInput={(event) => {
                            setProjectMartLargeRebuildPollIntervalMs(event.currentTarget.value)
                          }}
                          class="w-full px-3 py-3 border border-gray-300 rounded-md bg-white text-gray-900 sm:text-sm"
                        />
                      </div>
                      <div>
                        <label class="block text-sm font-medium text-gray-700 mb-2">Max Cycles Per Wake</label>
                        <input
                          type="number"
                          min="1"
                          value={projectMartLargeRebuildMaxCyclesPerWake()}
                          onInput={(event) => {
                            setProjectMartLargeRebuildMaxCyclesPerWake(event.currentTarget.value)
                          }}
                          class="w-full px-3 py-3 border border-gray-300 rounded-md bg-white text-gray-900 sm:text-sm"
                        />
                      </div>
                    </div>
                  </Show>
                  <div class="rounded-md border border-gray-200 bg-gray-50 p-4 space-y-2">
                    <p class="text-sm font-medium text-gray-900">Effective maintenance config</p>
                    <Show when={maintenanceRuntimeDiagnosticsQuery.isLoading}>
                      <p class="text-xs text-gray-500">Loading maintenance runtime diagnostics...</p>
                    </Show>
                    <Show when={maintenanceRuntimeDiagnosticsQuery.isError}>
                      <p class="text-xs text-red-600">
                        {maintenanceRuntimeDiagnosticsQuery.error instanceof Error
                          ? maintenanceRuntimeDiagnosticsQuery.error.message
                          : 'Failed to load maintenance runtime diagnostics'}
                      </p>
                    </Show>
                    <Show
                      when={
                        !maintenanceRuntimeDiagnosticsQuery.isLoading && !maintenanceRuntimeDiagnosticsQuery.isError
                      }
                    >
                      <p class="text-xs text-gray-600">
                        Current:{' '}
                        {formatTuningSummary(
                          maintenanceRuntimeDiagnosticsQuery.data?.projectMartLargeRebuildHeartbeat ?? {},
                        )}
                      </p>
                      <p class="text-xs text-gray-600">
                        Sources: batch{' '}
                        {formatTuningSource(
                          maintenanceRuntimeDiagnosticsQuery.data?.projectMartLargeRebuildHeartbeat?.sources?.batchSize,
                        )}
                        , poll{' '}
                        {formatTuningSource(
                          maintenanceRuntimeDiagnosticsQuery.data?.projectMartLargeRebuildHeartbeat?.sources
                            ?.pollIntervalMs,
                        )}
                        , burst{' '}
                        {formatTuningSource(
                          maintenanceRuntimeDiagnosticsQuery.data?.projectMartLargeRebuildHeartbeat?.sources
                            ?.maxCyclesPerWake,
                        )}
                      </p>
                      <p class="text-xs text-gray-600">
                        Automatic recommendation:{' '}
                        {formatTuningSummary(
                          maintenanceRuntimeDiagnosticsQuery.data?.projectMartLargeRebuildHeartbeat?.automatic ?? {},
                        )}
                      </p>
                      <p class="text-xs text-gray-600">
                        Auto profile:{' '}
                        {maintenanceRuntimeDiagnosticsQuery.data?.projectMartLargeRebuildHeartbeat?.automatic?.profile
                          ?? 'N/A'}{' '}
                        | Active rebuilds:{' '}
                        {maintenanceRuntimeDiagnosticsQuery.data?.projectMartLargeRebuildHeartbeat?.automatic
                          ?.activeLargeRebuildProjectCount ?? 'N/A'}{' '}
                        | Maintenance memory:{' '}
                        {maintenanceRuntimeDiagnosticsQuery.data?.duckdb?.effective?.memoryLimit ?? 'N/A'}
                      </p>
                    </Show>
                    <p class="text-xs text-gray-500">
                      Heartbeat tuning changes apply to the running maintenance runtime within a few seconds. DuckDB
                      memory-limit changes are saved immediately but only apply after the next server restart.
                    </p>
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
                    backgroundWriterDuckdbMemoryLimit: backgroundWriterDuckdbMemoryLimit(),
                    codexBin: codexBin(),
                    duckdbBin: duckdbBin(),
                    email: profileEmail(),
                    fullTextConversionModelId: fullTextConversionModelId(),
                    name: displayName(),
                    projectMartLargeRebuildBatchSize: projectMartLargeRebuildBatchSize(),
                    projectMartLargeRebuildMaxCyclesPerWake: projectMartLargeRebuildMaxCyclesPerWake(),
                    projectMartLargeRebuildPollIntervalMs: projectMartLargeRebuildPollIntervalMs(),
                    projectMartLargeRebuildTuningMode: projectMartLargeRebuildTuningMode(),
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
