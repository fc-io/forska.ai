import {useQuery} from '@tanstack/solid-query'
import {createFileRoute} from '@tanstack/solid-router'
import {createEffect, createSignal} from 'solid-js'

import {fetchSession} from '../../../services/fetchSession'
import {updateUserProfile} from '../../../services/usersService'

const Settings = () => {
  const [displayName, setDisplayName] = createSignal('')
  const [isSavingProfile, setIsSavingProfile] = createSignal(false)
  const [saveError, setSaveError] = createSignal('')
  const [saveSuccess, setSaveSuccess] = createSignal('')
  const sessionQuery = useQuery(() => {
    return {queryKey: ['session'], queryFn: fetchSession}
  })

  createEffect(() => {
    const sessionName = sessionQuery.data?.user?.name ?? ''
    setDisplayName(sessionName)
  })

  const handleSaveProfile = async () => {
    const userId = sessionQuery.data?.user?.id
    const currentName = sessionQuery.data?.user?.name ?? ''
    const trimmedDisplayName = displayName().trim()

    if (!userId) {
      setSaveError('Unable to update profile right now.')
      setSaveSuccess('')
      return
    }

    if (!trimmedDisplayName) {
      setSaveError('Display name cannot be empty.')
      setSaveSuccess('')
      return
    }

    if (trimmedDisplayName === currentName) {
      setSaveError('')
      setSaveSuccess('No changes to save.')
      return
    }

    setIsSavingProfile(true)
    setSaveError('')
    setSaveSuccess('')

    await updateUserProfile(userId, trimmedDisplayName)
      .then(() => {
        setSaveSuccess('Profile updated successfully.')
        setDisplayName(trimmedDisplayName)
        return sessionQuery.refetch()
      })
      .catch((error) => {
        setSaveError(error instanceof Error ? error.message : 'Failed to update profile.')
      })

    setIsSavingProfile(false)
  }

  const isSaveDisabled = () => {
    const currentName = sessionQuery.data?.user?.name ?? ''
    return isSavingProfile() || !displayName().trim() || displayName().trim() === currentName
  }

  return (
    <div class="p-6 max-w-4xl mx-auto">
      <h1 class="text-3xl font-bold mb-6">User Settings</h1>

      <div class="space-y-6">
        {/* Profile Section */}
        <div class="bg-white border border-gray-200 rounded-lg shadow-sm p-6">
          <h2 class="text-xl font-semibold text-gray-900 mb-4">Profile</h2>
          <div class="space-y-4">
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-2">Email</label>
              <input
                type="email"
                value={sessionQuery.data?.user?.email || ''}
                readonly
                class="w-full px-3 py-3 border border-gray-300 rounded-md bg-gray-50 text-gray-500"
              />
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-2">Display Name</label>
              <input
                type="text"
                value={displayName()}
                onInput={(event) => {
                  return setDisplayName(event.currentTarget.value)
                }}
                class="w-full px-3 py-3 border border-gray-300 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
              />
              {saveError() && <p class="mt-2 text-sm text-red-600">{saveError()}</p>}
              {saveSuccess() && !saveError() && <p class="mt-2 text-sm text-green-600">{saveSuccess()}</p>}
            </div>
          </div>
        </div>

        {/* Actions */}
        <div class="flex gap-4">
          <button
            class="px-4 py-3 bg-blue-600 text-white rounded-md shadow-sm hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 text-sm font-medium disabled:opacity-60 disabled:cursor-not-allowed"
            disabled={isSaveDisabled()}
            onClick={() => {
              void handleSaveProfile()
            }}
          >
            {isSavingProfile() ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/settings/')({component: Settings})
