import {createFileRoute} from '@tanstack/solid-router'
import {formatDate} from 'date-fns'
import {createResource, createSignal, For} from 'solid-js'

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
    <div class="p-6 max-w-7xl mx-auto">
      <div class="flex justify-between items-center mb-6">
        <h1 class="text-3xl font-bold">User Management</h1>
        <button
          class="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
          disabled
        >
          Invite User
        </button>
      </div>

      {/* Filters */}
      <div class="bg-card border rounded-lg p-4 mb-6">
        <div class="flex gap-4 items-center">
          <div class="flex-1">
            <input
              type="text"
              placeholder="Search users by name..."
              value={searchTerm()}
              onInput={(e) => {
                return setSearchTerm(e.currentTarget.value)
              }}
              class="w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
          <div>
            <select
              value={selectedRole()}
              onChange={(e) => {
                return setSelectedRole(e.currentTarget.value)
              }}
              class="px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <option value="all">All Users</option>
              <option value="admin">Admins</option>
              <option value="user">Users</option>
            </select>
          </div>
        </div>
      </div>

      {/* Loading and Error States */}
      {users.loading && (
        <div class="bg-card border rounded-lg p-6 text-center mb-6">
          <p class="text-muted-foreground">Loading users...</p>
        </div>
      )}
      {users.error && (
        <div class="bg-destructive/10 border border-destructive rounded-lg p-4 mb-6">
          <p class="text-destructive">Failed to load users</p>
          <button
            onClick={() => {
              return void refetch()
            }}
            class="mt-2 px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
          >
            Retry
          </button>
        </div>
      )}

      {/* Stats */}
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div class="bg-card border rounded-lg p-4 text-center">
          <div class="text-2xl font-bold text-primary">{(users() ?? []).length}</div>
          <div class="text-sm text-muted-foreground">Total Users</div>
        </div>
        <div class="bg-card border rounded-lg p-4 text-center">
          <div class="text-2xl font-bold text-red-600">
            {
              (users() ?? []).filter((u) => {
                return u.role === 'admin'
              }).length
            }
          </div>
          <div class="text-sm text-muted-foreground">Admins</div>
        </div>
        <div class="bg-card border rounded-lg p-4 text-center">
          <div class="text-2xl font-bold text-green-600">
            {
              (users() ?? []).filter((u) => {
                return u.role !== 'admin'
              }).length
            }
          </div>
          <div class="text-sm text-muted-foreground">Regular Users</div>
        </div>
      </div>

      {/* Users Table */}
      <div class="bg-card border rounded-lg overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full">
            <thead class="bg-muted">
              <tr>
                <th class="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  User
                </th>
                <th class="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Role
                </th>
                <th class="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Created At
                </th>
                <th class="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border">
              <For each={filteredUsers()}>
                {(user) => {
                  return (
                    <tr class="hover:bg-muted/50">
                      <td class="px-6 py-4">
                        <div>
                          <div class="font-medium">
                            {user.name || 'No name set'}
                          </div>
                          <div class="text-sm text-muted-foreground">
                            ID: {user.id}
                          </div>
                        </div>
                      </td>
                      <td class="px-6 py-4">
                        <span
                          class={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${getRoleColor(user.role)}`}
                        >
                          {user.role === 'admin' ? 'Admin' : 'User'}
                        </span>
                      </td>
                      <td class="px-6 py-4 text-sm text-muted-foreground">
                        {user.createdAt
                          ? formatDate(new Date(user.createdAt), 'yyyy-MM-dd')
                          : 'Unknown'}
                      </td>
                      <td class="px-6 py-4">
                        <div class="flex gap-2">
                          <button class="text-sm text-primary hover:text-primary/80">
                            Edit
                          </button>
                          <button class="text-sm text-destructive hover:text-destructive/80">
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
