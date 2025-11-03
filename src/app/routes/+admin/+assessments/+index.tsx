import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {For, Show, Suspense} from 'solid-js'

import {fetchSession} from '../../../../services/fetchSession'
import {apiClient} from '../../../../services/apiClient'
import {handleApiResponse} from '../../../../services/utils/handleApiResponse'

export const AdminAssessments = () => {
  const sessionQuery = useQuery(() => {
    return {queryKey: ['session'], queryFn: fetchSession}
  })

  const isAdmin = () => {
    return sessionQuery.data?.user?.role === 'admin'
  }

  type OverviewData = {
    projects: Array<{projectId: string; projectName: string; count: number}>
    users: Array<{userId: string; userName: string; email: string; count: number}>
  }

  const overviewQuery = useQuery(() => {
    return {
      queryKey: ['human-assessments-overview'],
      queryFn: async () => {
        const response = await apiClient.api.humanassessment.overview.get()
        const result = handleApiResponse<{data: OverviewData}>(
          response,
          'Failed to fetch assessments overview',
        )
        return result.data
      },
      enabled: isAdmin(),
      staleTime: 10_000,
    }
  })

  const projectRows = () => {
    return overviewQuery.data?.projects ?? []
  }
  const userRows = () => {
    return overviewQuery.data?.users ?? []
  }


  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto">
      <Suspense
        fallback={
          <div class="flex items-center justify-center h-64">
            <div class="flex items-center space-x-2">
              <svg class="animate-spin h-6 w-6 text-blue-600" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none" />
                <path
                  class="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              <span class="text-gray-600">Checking permissions...</span>
            </div>
          </div>
        }
      >
        <Show
          when={isAdmin()}
          fallback={
            <div class="bg-white border border-gray-200 rounded-lg shadow-sm max-w-xl mx-auto p-10 text-center">
              <h1 class="text-2xl font-semibold text-gray-900 mb-2">Administrator Access Required</h1>
              <p class="text-gray-500 mb-6">You need administrator privileges to view assessments.</p>
              <Link
                to="/"
                class="inline-flex items-center justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                Go back home
              </Link>
            </div>
          }
        >
          <div class="flex items-center justify-between mb-6">
            <h1 class="text-2xl font-bold">Human Assessments Overview</h1>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
            <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
              <div class="text-sm text-gray-500">Projects with assessments</div>
              <div class="text-2xl font-semibold text-gray-900">{projectRows().length}</div>
            </div>
            <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
              <div class="text-sm text-gray-500">Users with assessments</div>
              <div class="text-2xl font-semibold text-gray-900">{userRows().length}</div>
            </div>
          </div>

          <div class="space-y-6">
            <div class="bg-white rounded-lg shadow-sm border border-gray-200">
              <div class="px-4 py-3 border-b border-gray-200">
                <h2 class="text-lg font-semibold">Per Project</h2>
              </div>
              <div class="overflow-x-auto">
                <table class="min-w-full divide-y divide-gray-200">
                  <thead class="bg-gray-50">
                    <tr>
                      <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Project</th>
                      <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Assessments</th>
                    </tr>
                  </thead>
                  <tbody class="bg-white divide-y divide-gray-200">
                    <Show
                      when={projectRows().length > 0}
                      fallback={
                        <tr>
                          <td colSpan={2} class="px-6 py-6 text-center text-sm text-gray-500">
                            No project assessments yet.
                          </td>
                        </tr>
                      }
                    >
                      <For each={projectRows()}>
                        {(row) => {
                          return (
                            <tr>
                              <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{row.projectName}</td>
                              <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{row.count}</td>
                            </tr>
                          )
                        }}
                      </For>
                    </Show>
                  </tbody>
                </table>
              </div>
            </div>

            <div class="bg-white rounded-lg shadow-sm border border-gray-200">
              <div class="px-4 py-3 border-b border-gray-200">
                <h2 class="text-lg font-semibold">Per User</h2>
              </div>
              <div class="overflow-x-auto">
                <table class="min-w-full divide-y divide-gray-200">
                  <thead class="bg-gray-50">
                    <tr>
                      <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">User</th>
                      <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Assessments</th>
                    </tr>
                  </thead>
                  <tbody class="bg-white divide-y divide-gray-200">
                    <Show
                      when={userRows().length > 0}
                      fallback={
                        <tr>
                          <td colSpan={2} class="px-6 py-6 text-center text-sm text-gray-500">
                            No user assessments yet.
                          </td>
                        </tr>
                      }
                    >
                      <For each={userRows()}>
                        {(row) => {
                          return (
                            <tr>
                              <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{row.userName}</td>
                              <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{row.count}</td>
                            </tr>
                          )
                        }}
                      </For>
                    </Show>
                  </tbody>
                </table>
              </div>
            </div>

            
          </div>
        </Show>
      </Suspense>
    </div>
  )
}

export const Route = createFileRoute('/admin/assessments/')({component: AdminAssessments})
