import {createFileRoute} from '@tanstack/solid-router'
import {formatDate} from 'date-fns'
import {createResource, createSignal, For, Show} from 'solid-js'

import {fetchUsers} from '../../../../services/usersService.ts'

const AdminUsers = () => {
  const [users, {refetch}] = createResource(fetchUsers)

  const [searchTerm, setSearchTerm] = createSignal('')
  const [selectedRole, setSelectedRole] = createSignal('all')

  const filteredUsers = () => {
    const usersList = users() ?? []
    return usersList.filter((user) => {
      const term = searchTerm().toLowerCase()
      const matchesSearch =
        (term === '' || user.name?.toLowerCase().includes(term)) ?? false
      const matchesRole =
        selectedRole() === 'all'
        || (selectedRole() === 'admin' && user.role === 'admin')
        || (selectedRole() === 'user' && user.role !== 'admin')

      return matchesSearch && matchesRole
    })
  }

  const getRoleColor = (role: string | null) => {
    return role === 'admin'
      ? 'bg-red-100 text-red-800'
      : 'bg-green-100 text-green-800'
  }

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto">
      <div class="flex justify-between items-center mb-6">
        <h1 class="text-2xl font-bold">User Management</h1>
        <button
          class="px-4 py-2 bg-gray-100 text-gray-400 rounded-md cursor-not-allowed"
          disabled
        >
          Invite User
        </button>
      </div>
      
      <div class="space-y-4">
        {/* Filters */}
        <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <div class="flex gap-4 items-center">
            <div class="flex-1">
              <input
                type="text"
                placeholder="Search users by name..."
                value={searchTerm()}
                onInput={(e) => {
                  return setSearchTerm(e.currentTarget.value)
                }}
                class="w-full px-3 py-2 border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <select
                value={selectedRole()}
                onChange={(e) => {
                  return setSelectedRole(e.currentTarget.value)
                }}
                class="px-3 py-2 border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="all">All Users</option>
                <option value="admin">Admins</option>
                <option value="user">Users</option>
              </select>
            </div>
          </div>
        </div>

        {/* Loading and Error States */}
        <Show when={users.loading}>
          <p class="text-muted-foreground">Loading users...</p>
        </Show>
        <Show when={users.error}>
          <div class="p-4 rounded-md bg-red-50 border border-red-200">
            <p class="text-red-600">Failed to load users</p>
            <button
              onClick={() => {
                return void refetch()
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
              <span class="font-semibold text-gray-900">{(users() ?? []).length}</span> users
            </span>
            <span>
              <span class="font-semibold text-red-600">
                {(users() ?? []).filter((u) => u.role === 'admin').length}
              </span> admins
            </span>
            <span>
              <span class="font-semibold text-green-600">
                {(users() ?? []).filter((u) => u.role !== 'admin').length}
              </span> regular
            </span>
          </div>
        </div>

        {/* Users Table */}
        <div class="overflow-x-auto bg-white rounded-lg shadow">
          <table class="min-w-full divide-y divide-gray-200">
            <thead class="bg-gray-50">
              <tr>
                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  User
                </th>
                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Role
                </th>
                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Created At
                </th>
                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actions
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
                          <div class="font-medium text-gray-900">
                            {user.name || 'No name set'}
                          </div>
                          <div class="text-sm text-gray-500">
                            ID: {user.id}
                          </div>
                        </div>
                      </td>
                      <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        <span
                          class={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${getRoleColor(user.role)}`}
                        >
                          {user.role === 'admin' ? 'Admin' : 'User'}
                        </span>
                      </td>
                      <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        {user.createdAt
                          ? formatDate(new Date(user.createdAt), 'yyyy-MM-dd')
                          : 'Unknown'}
                      </td>
                      <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        <div class="flex gap-2">
                          <button class="text-sm text-blue-600 hover:text-blue-800">
                            Edit
                          </button>
                          <button class="text-sm text-red-600 hover:text-red-800">
                            {user.role === 'admin'
                              ? 'Remove Admin'
                              : 'Make Admin'}
                          </button>
                        </div>
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
