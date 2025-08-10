import {createFileRoute, redirect} from '@tanstack/solid-router'
import {createResource, createSignal, For, Show} from 'solid-js'

import {authClient} from '../lib/auth-client'

const checkAuth = async () => {
  const session = await authClient.getSession()
  if (!session.data?.session) {
    throw redirect({to: '/signin', search: {redirect: '/projects'}})
  }
  return session
}

export const ProjectsPage = () => {
  const [projects] = createSignal([
    {id: 1, name: 'Project Alpha', status: 'Active'},
    {id: 2, name: 'Project Beta', status: 'In Progress'},
    {id: 3, name: 'Project Gamma', status: 'Completed'},
  ])

  const [session] = createResource(() => {
    return authClient.getSession()
  })

  return (
    <div class="container mx-auto p-4">
      <h1 class="text-2xl font-bold mb-6">Projects</h1>

      <Show when={session()?.data?.user}>
        <p class="mb-4 text-gray-600">
          Welcome, {session()?.data?.user?.email}
        </p>
      </Show>

      <div class="grid gap-4">
        <For each={projects()}>
          {(project) => {
            return (
              <div class="border rounded-lg p-4 hover:bg-gray-50">
                <h2 class="text-lg font-semibold">{project.name}</h2>
                <p class="text-sm text-gray-600">Status: {project.status}</p>
              </div>
            )
          }}
        </For>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/projects')({
  beforeLoad: async () => {
    await checkAuth()
  },
  component: ProjectsPage,
})
