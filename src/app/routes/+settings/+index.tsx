import {createMutation, useQuery} from '@tanstack/solid-query'
import {createFileRoute} from '@tanstack/solid-router'
import {createEffect, createSignal, Show} from 'solid-js'

import {apiClient} from '../../../services/apiClient'
import {handleApiResponse} from '../../../services/utils/handleApiResponse'

type LocalUser = {id: string; name: string; email: string; role?: string | null; unpaywallEmail?: string | null}
type UsersResponse = {data: LocalUser[]}
type UpdateLocalUserInput = {email: string; name: string; unpaywallEmail: string}
type UpdateUserResponse = {data: LocalUser}

const fetchLocalUser = async (): Promise<LocalUser | null> => {
  const response = await apiClient.api.users.get()
  const result = handleApiResponse<UsersResponse>(response, 'Failed to load local user')
  return result.data?.[0] ?? null
}

const getNullableEmail = (value: string): string | null => {
  const normalized = value.trim()

  return normalized === '' ? null : normalized
}

const updateLocalUser = async (input: UpdateLocalUserInput): Promise<LocalUser> => {
  const response = await apiClient.api.users.patch({
    email: input.email,
    name: input.name,
    unpaywallEmail: getNullableEmail(input.unpaywallEmail),
  })
  const result = handleApiResponse<UpdateUserResponse>(response, 'Failed to save settings')

  return result.data
}

const Settings = () => {
  const [displayName, setDisplayName] = createSignal('')
  const [profileEmail, setProfileEmail] = createSignal('')
  const [unpaywallEmail, setUnpaywallEmail] = createSignal('')
  const localUserQuery = useQuery(() => {
    return {queryKey: ['local-user'], queryFn: fetchLocalUser, staleTime: 5 * 60 * 1000, refetchOnWindowFocus: false}
  })
  const updateLocalUserMutation = createMutation(() => {
    return {
      mutationFn: updateLocalUser,
      onSuccess: (user: LocalUser) => {
        setDisplayName(user.name)
        setProfileEmail(user.email)
        setUnpaywallEmail(user.unpaywallEmail ?? '')
        void localUserQuery.refetch()
      },
    }
  })

  createEffect(() => {
    setDisplayName(localUserQuery.data?.name ?? '')
    setProfileEmail(localUserQuery.data?.email ?? '')
    setUnpaywallEmail(localUserQuery.data?.unpaywallEmail ?? '')
  })

  const isProfileDirty = () => {
    return (
      displayName().trim() !== (localUserQuery.data?.name ?? '').trim()
      || profileEmail().trim() !== (localUserQuery.data?.email ?? '').trim()
      || unpaywallEmail().trim() !== (localUserQuery.data?.unpaywallEmail ?? '').trim()
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
                    email: profileEmail(),
                    name: displayName(),
                    unpaywallEmail: unpaywallEmail(),
                  })
                }}
              >
                {updateLocalUserMutation.isPending ? 'Saving...' : 'Save Profile'}
              </button>
            </div>
          </Show>
        </div>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/settings/')({component: Settings})
