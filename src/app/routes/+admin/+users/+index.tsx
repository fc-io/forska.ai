import {useQuery} from '@tanstack/solid-query'
import {createFileRoute} from '@tanstack/solid-router'
import {formatDate} from 'date-fns'
import {createSignal, For, Show} from 'solid-js'

import {fetchUsers} from '../../../../services/usersService.ts'

const AdminUsers = () => {
  const users = useQuery(() => {
    return {queryKey: ['users'], queryFn: fetchUsers}
  })

  const [searchTerm, setSearchTerm] = createSignal('')

  const filteredUsers = () => {
    const usersList = users.data ?? []
    return usersList.filter((user) => {
      const term = searchTerm().toLowerCase()
      const matchesName = user.name?.toLowerCase().includes(term) ?? false
      const matchesEmail = user.email?.toLowerCase().includes(term) ?? false
      const matchesId = user.id?.toLowerCase().includes(term) ?? false
      return term === '' ? true : matchesName || matchesEmail || matchesId
    })
  }

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto">
      <div class="flex justify-between items-center mb-6">
        <h1 class="text-2xl font-bold">Users</h1>
      </div>

      <div class="space-y-4">
        {/* Filters */}
        <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <div class="flex gap-4 items-center">
            <div class="flex-1">
              <input
                type="text"
                placeholder="Search users by name, email, or id..."
                value={searchTerm()}
                onInput={(e) => {
                  return setSearchTerm(e.currentTarget.value)
                }}
                class="w-full px-3 py-2 border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
        </div>

        {/* Loading and Error States */}
        <Show when={users.isLoading}>
          <p class="text-muted-foreground">Loading users...</p>
        </Show>
        <Show when={users.isError}>
          <div class="p-4 rounded-md bg-red-50 border border-red-200">
            <p class="text-red-600">Failed to load users</p>
            <button
              onClick={() => {
                return void users.refetch()
              }}
              class="mt-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
            >
              Retry
            </button>
          </div>
        </Show>

        {/* Stats */}
        <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
          <div class="flex gap-6 text-sm text-gray-600">
            <span>
              <span class="font-semibold text-gray-900">{(users.data ?? []).length}</span> users
            </span>
          </div>
        </div>

        {/* Users Table */}
        <div class="overflow-x-auto bg-white rounded-lg shadow">
          <table class="min-w-full divide-y divide-gray-200">
            <thead class="bg-gray-50">
              <tr>
                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">User</th>
                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Email</th>
                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Created At
                </th>
              </tr>
            </thead>
            <tbody class="bg-white divide-y divide-gray-200">
              <For each={filteredUsers()}>
                {(user) => {
                  return (
                    <tr class="hover:bg-gray-50">
                      <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        <div>
                          <div class="font-medium text-gray-900">{user.name || 'No name set'}</div>
                          <div class="text-sm text-gray-500">ID: {user.id}</div>
                        </div>
                      </td>
                      <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{user.email}</td>
                      <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        {user.createdAt ? formatDate(new Date(user.createdAt), 'yyyy-MM-dd') : 'Unknown'}
                      </td>
                    </tr>
                  )
                }}
              </For>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/admin/users/')({component: AdminUsers})
