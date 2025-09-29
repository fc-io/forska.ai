import {useQuery} from '@tanstack/solid-query'
import {createFileRoute} from '@tanstack/solid-router'
import {createSignal} from 'solid-js'

import {fetchSession} from '../../../services/fetchSession'

const Settings = () => {
  const [notifications, setNotifications] = createSignal(true)
  const [autoProcess, setAutoProcess] = createSignal(false)
  const [theme, setTheme] = createSignal('system')
  const sessionQuery = useQuery(() => {
    return {queryKey: ['session'], queryFn: fetchSession}
  })

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
                placeholder="Enter your display name"
                class="w-full px-3 py-3 border border-gray-300 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
              />
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-2">Organization</label>
              <input
                type="text"
                placeholder="Your organization or institution"
                class="w-full px-3 py-3 border border-gray-300 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
              />
            </div>
          </div>
        </div>

        {/* Preferences Section */}
        <div class="bg-white border border-gray-200 rounded-lg shadow-sm p-6">
          <h2 class="text-xl font-semibold text-gray-900 mb-4">Preferences</h2>
          <div class="space-y-4">
            <div class="flex items-center justify-between">
              <div>
                <label class="block text-sm font-medium text-gray-700">Email Notifications</label>
                <p class="text-sm text-gray-500">Receive updates about new articles and processing status</p>
              </div>
              <label class="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={notifications()}
                  onChange={(e) => {
                    return setNotifications(e.currentTarget.checked)
                  }}
                  class="sr-only peer"
                />
                <div class="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600" />
              </label>
            </div>

            <div class="flex items-center justify-between">
              <div>
                <label class="block text-sm font-medium text-gray-700">Auto-process Articles</label>
                <p class="text-sm text-gray-500">Automatically assess new articles with AI</p>
              </div>
              <label class="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoProcess()}
                  onChange={(e) => {
                    return setAutoProcess(e.currentTarget.checked)
                  }}
                  class="sr-only peer"
                />
                <div class="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600" />
              </label>
            </div>

            <div>
              <label class="block text-sm font-medium text-gray-700 mb-2">Theme</label>
              <select
                value={theme()}
                onChange={(e) => {
                  return setTheme(e.currentTarget.value)
                }}
                class="w-full px-3 py-3 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
              >
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div class="flex gap-4">
          <button class="px-4 py-3 bg-blue-600 text-white rounded-md shadow-sm hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 text-sm font-medium">
            Save Changes
          </button>
          <button class="px-4 py-3 border border-gray-300 bg-white text-gray-900 rounded-md shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 text-sm font-medium">
            Reset to Defaults
          </button>
        </div>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/settings/')({component: Settings})
