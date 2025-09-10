import {Link} from '@tanstack/solid-router'
import {Show} from 'solid-js'

import type {User} from '../types/user'

interface NavigationProps {
  user: User | undefined
  onSignOut: () => void
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
              to="/articles"
              class="text-gray-900 hover:text-blue-600 px-3 py-2 text-sm font-medium [&.active]:text-blue-600 [&.active]:font-semibold"
            >
              Articles
            </Link>
            <Link
              to="/projects"
              class="text-gray-900 hover:text-blue-600 px-3 py-2 text-sm font-medium [&.active]:text-blue-600 [&.active]:font-semibold"
            >
              Projects
            </Link>
            <Link
              to="/about"
              class="text-gray-900 hover:text-blue-600 px-3 py-2 text-sm font-medium [&.active]:text-blue-600 [&.active]:font-semibold"
            >
              About
            </Link>
          </div>
          <div class="flex items-center space-x-4">
            <Link
              to="/settings"
              class="text-gray-600 hover:text-blue-600 text-sm font-medium"
            >
              Settings
            </Link>
            <Show when={props.user?.role === 'admin'}>
              <Link
                to="/admin/users"
                class="text-gray-600 hover:text-blue-600 text-sm font-medium"
              >
                Users
              </Link>
              <Link
                to="/admin/jobs"
                class="text-gray-600 hover:text-blue-600 text-sm font-medium"
              >
                Jobs
              </Link>
            </Show>
            <Show when={props.user}>
              <span class="text-sm text-gray-500">{props.user?.email}</span>
            </Show>
            <button
              onClick={() => {
                props.onSignOut()
              }}
              class="text-gray-600 hover:text-blue-600 text-sm font-medium"
            >
              Sign Out
            </button>
          </div>
        </div>
      </div>
    </nav>
  )
}
