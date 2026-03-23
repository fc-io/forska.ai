import {createMutation, useQuery} from '@tanstack/solid-query'
import {createFileRoute} from '@tanstack/solid-router'
import {createEffect, createSignal, For, Show} from 'solid-js'

import {apiClient} from '../../../services/apiClient'
import {handleApiResponse} from '../../../services/utils/handleApiResponse'

type LocalUser = {
  id: string
  name: string
  email: string
  role?: string | null
  fullTextConversionModelId?: string | null
  unpaywallEmail?: string | null
  duckdbBin?: string | null
  codexBin?: string | null
}
type UsersResponse = {data: LocalUser[]}
type StoredModel = {displayName?: string | null; enabled: boolean; id: string; name: string; provider: string}
type UpdateLocalUserInput = {
  email: string
  name: string
  fullTextConversionModelId: string
  unpaywallEmail: string
  duckdbBin: string
  codexBin: string
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

const getNullableString = (value: string): string | null => {
  const normalized = value.trim()

  return normalized === '' ? null : normalized
}

const updateLocalUser = async (input: UpdateLocalUserInput): Promise<LocalUser> => {
  const response = await apiClient.api.users.patch({
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

const Settings = () => {
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
  const updateLocalUserMutation = createMutation(() => {
    return {
      mutationFn: updateLocalUser,
      onSuccess: (user: LocalUser) => {
        setDisplayName(user.name)
        setProfileEmail(user.email)
        setFullTextConversionModelId(user.fullTextConversionModelId ?? '')
        setUnpaywallEmail(user.unpaywallEmail ?? '')
        setDuckdbBin(user.duckdbBin ?? '')
        setCodexBin(user.codexBin ?? '')
        void localUserQuery.refetch()
      },
    }
  })

  createEffect(() => {
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
                      return <option value={model.id}>{model.displayName ?? model.name}</option>
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
