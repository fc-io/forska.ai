import {createFileRoute, redirect} from '@tanstack/solid-router'
import {createResource, createSignal, For, Show} from 'solid-js'

import {authClient} from '../lib/auth-client'

const checkAdminAuth = async () => {
  const session = await authClient.getSession()
  if (!session.data?.session) {
    throw redirect({to: '/signin', search: {redirect: '/users'}})
  }

  const isAdmin = await authClient.admin.isAdmin()
  if (!isAdmin) {
    throw redirect({to: '/', search: {error: 'Admin access required'}})
  }

  return session
}

export const UsersPage = () => {
  const [users] = createSignal([
    {id: 1, email: 'admin@example.com', role: 'Admin', status: 'Active'},
    {id: 2, email: 'user1@example.com', role: 'User', status: 'Active'},
    {id: 3, email: 'user2@example.com', role: 'User', status: 'Inactive'},
    {id: 4, email: 'user3@example.com', role: 'User', status: 'Active'},
  ])

  const [session] = createResource(() => {
    return authClient.getSession()
  })

  return (
    <div class="container mx-auto p-4">
      <h1 class="text-2xl font-bold mb-6">User Management</h1>

      <Show when={session()?.data?.user}>
        <p class="mb-4 text-gray-600">
          Admin panel - Logged in as: {session()?.data?.user?.email}
        </p>
      </Show>

      <div class="overflow-x-auto">
        <table class="min-w-full bg-white border border-gray-200">
          <thead>
            <tr class="bg-gray-100 border-b">
              <th class="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                ID
              </th>
              <th class="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                Email
              </th>
              <th class="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                Role
              </th>
              <th class="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                Status
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-200">
            <For each={users()}>
              {(user) => {
                return (
                  <tr class="hover:bg-gray-50">
                    <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {user.id}
                    </td>
                    <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {user.email}
                    </td>
                    <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      <span
                        class={`px-2 py-1 text-xs rounded-full ${
                          user.role === 'Admin'
                            ? 'bg-purple-100 text-purple-800'
                            : 'bg-gray-100 text-gray-800'
                        }`}
                      >
                        {user.role}
                      </span>
                    </td>
                    <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      <span
                        class={`px-2 py-1 text-xs rounded-full ${
                          user.status === 'Active'
                            ? 'bg-green-100 text-green-800'
                            : 'bg-red-100 text-red-800'
                        }`}
                      >
                        {user.status}
                      </span>
                    </td>
                  </tr>
                )
              }}
            </For>
          </tbody>
        </table>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/users')({
  beforeLoad: async () => {
    await checkAdminAuth()
  },
  component: UsersPage,
})
