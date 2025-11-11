import {Menu} from '@ark-ui/solid'
import {Link} from '@tanstack/solid-router'
import {Show} from 'solid-js'

import type {User} from '../types/user'

interface NavigationProps {
  user: User | undefined
  onSignOut: () => void
}

const getAvatarLabel = (user: User | undefined) => {
  const defaultLabel = 'U'
  if (!user) {
    return defaultLabel
  }
  const trimmedName = user.name?.trim()
  if (trimmedName) {
    return trimmedName
      .split(/\s+/)
      .filter((part) => {
        return part.length > 0
      })
      .map((part) => {
        return part[0] ?? ''
      })
      .join('')
      .slice(0, 2)
      .toUpperCase()
  }
  const trimmedEmail = user.email?.trim()
  if (trimmedEmail) {
    return trimmedEmail.slice(0, 2).toUpperCase()
  }
  return defaultLabel
}

export const Navigation = (props: NavigationProps) => {
  return (
    <nav class="bg-white shadow-sm border-b border-gray-200">
      <div class="px-4 sm:px-6 lg:px-8">
        <div class="flex justify-between h-16">
          <div class="flex items-center space-x-8">
            <Link
              to="/"
              class="text-gray-900 hover:text-blue-600 px-3 py-2 text-sm font-medium [&.active]:text-blue-600 [&.active]:font-semibold"
            >
              Home
            </Link>
            <Link
              to="/latest-articles"
              class="text-gray-900 hover:text-blue-600 px-3 py-2 text-sm font-medium [&.active]:text-blue-600 [&.active]:font-semibold"
            >
              Latest Articles
            </Link>
          </div>
          <div class="flex items-center space-x-4">
            <Show when={props.user?.role === 'admin'}>
              <Link to="/admin/assessments" class="text-gray-600 hover:text-blue-600 text-sm font-medium">
                Assessments
              </Link>
              <Link to="/admin/datasources" class="text-gray-600 hover:text-blue-600 text-sm font-medium">
                Data Sources
              </Link>
              <Link to="/admin/jobs" class="text-gray-600 hover:text-blue-600 text-sm font-medium">
                Jobs
              </Link>
              <Link to="/admin/llm" class="text-gray-600 hover:text-blue-600 text-sm font-medium">
                LLM Metrics
              </Link>
              <Link to="/admin/configuration" class="text-gray-600 hover:text-blue-600 text-sm font-medium">
                Configuration
              </Link>
              <Link to="/admin/users" class="text-gray-600 hover:text-blue-600 text-sm font-medium">
                Users
              </Link>
            </Show>
            <Show when={props.user}>
              <Menu.Root positioning={{placement: 'bottom-end'}}>
                <Menu.Trigger class="inline-flex items-center justify-center w-9 h-9 rounded-full bg-gray-200 text-sm font-semibold text-gray-700 hover:bg-gray-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
                  <span aria-hidden="true">{getAvatarLabel(props.user)}</span>
                  <span class="sr-only">Open user menu</span>
                </Menu.Trigger>
                <Menu.Positioner>
                  <Menu.Content class="mt-2 w-40 rounded-md bg-white py-2 shadow-lg ring-1 ring-black ring-opacity-5 focus:outline-none">
                    <Menu.Item id="settings" class="p-0">
                      <Link
                        to="/settings"
                        class="block w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100"
                      >
                        Settings
                      </Link>
                    </Menu.Item>
                    <Menu.Item id="sign-out" class="p-0">
                      <Link
                        to="/login"
                        class="block w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100"
                        onClick={() => {
                          props.onSignOut()
                        }}
                      >
                        Sign Out
                      </Link>
                    </Menu.Item>
                  </Menu.Content>
                </Menu.Positioner>
              </Menu.Root>
            </Show>
          </div>
        </div>
      </div>
    </nav>
  )
}
