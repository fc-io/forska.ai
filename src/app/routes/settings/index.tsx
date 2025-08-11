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
        <div class="bg-card border rounded-lg p-6">
          <h2 class="text-xl font-semibold mb-4">Profile</h2>
          <div class="space-y-4">
            <div>
              <label class="block text-sm font-medium mb-2">Email</label>
              <input
                type="email"
                value={sessionQuery.data?.user?.email || ''}
                readonly
                class="w-full px-3 py-2 border rounded-md bg-muted text-muted-foreground"
              />
            </div>
            <div>
              <label class="block text-sm font-medium mb-2">Display Name</label>
              <input
                type="text"
                placeholder="Enter your display name"
                class="w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <div>
              <label class="block text-sm font-medium mb-2">Organization</label>
              <input
                type="text"
                placeholder="Your organization or institution"
                class="w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
          </div>
        </div>

        {/* Preferences Section */}
        <div class="bg-card border rounded-lg p-6">
          <h2 class="text-xl font-semibold mb-4">Preferences</h2>
          <div class="space-y-4">
            <div class="flex items-center justify-between">
              <div>
                <label class="block text-sm font-medium">
                  Email Notifications
                </label>
                <p class="text-sm text-muted-foreground">
                  Receive updates about new articles and processing status
                </p>
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
                <div class="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary" />
              </label>
            </div>

            <div class="flex items-center justify-between">
              <div>
                <label class="block text-sm font-medium">
                  Auto-process Articles
                </label>
                <p class="text-sm text-muted-foreground">
                  Automatically assess new articles with AI
                </p>
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
                <div class="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary" />
              </label>
            </div>

            <div>
              <label class="block text-sm font-medium mb-2">Theme</label>
              <select
                value={theme()}
                onChange={(e) => {
                  return setTheme(e.currentTarget.value)
                }}
                class="w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </div>
          </div>
        </div>

        {/* API Settings */}
        <div class="bg-card border rounded-lg p-6">
          <h2 class="text-xl font-semibold mb-4">API Settings</h2>
          <div class="space-y-4">
            <div>
              <label class="block text-sm font-medium mb-2">
                API Rate Limit
              </label>
              <select class="w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-primary">
                <option value="low">Low (100 requests/hour)</option>
                <option value="medium">Medium (500 requests/hour)</option>
                <option value="high">High (1000 requests/hour)</option>
              </select>
            </div>
            <div>
              <label class="block text-sm font-medium mb-2">
                Default Search Filters
              </label>
              <textarea
                placeholder="Enter default search parameters..."
                rows="3"
                class="w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
          </div>
        </div>

        {/* Actions */}
        <div class="flex gap-4">
          <button class="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90">
            Save Changes
          </button>
          <button class="px-4 py-2 border rounded-md hover:bg-accent">
            Reset to Defaults
          </button>
        </div>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/settings/')({component: Settings})
