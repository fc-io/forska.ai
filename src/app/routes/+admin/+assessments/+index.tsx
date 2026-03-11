import {useQuery} from '@tanstack/solid-query'
import {createFileRoute} from '@tanstack/solid-router'
import {For, Show} from 'solid-js'

import {apiClient} from '../../../../services/apiClient'
import {handleApiResponse} from '../../../../services/utils/handleApiResponse'

export const AdminAssessments = () => {
  type OverviewData = {
    projects: Array<{projectId: string; projectName: string; count: number}>
    users: Array<{userId: string; userName: string; email: string; count: number}>
  }
  type BothProjectsRow = {projectId: string; projectName: string; count: number}

  const overviewQuery = useQuery(() => {
    return {
      queryKey: ['human-assessments-overview'],
      queryFn: async () => {
        const response = await apiClient.api.humanassessment.overview.get()
        const result = handleApiResponse<{data: OverviewData}>(
          response as {data?: {data: OverviewData}; error?: unknown},
          'Failed to fetch assessments overview',
        )
        return result.data
      },
      staleTime: 10_000,
    }
  })

  const bothProjectsQuery = useQuery(() => {
    return {
      queryKey: ['human-assessments-overview-both-projects'],
      queryFn: async () => {
        const response = await apiClient.api.humanassessment['overview-both-projects'].get()
        const result = handleApiResponse<{data: Array<BothProjectsRow>}>(
          response as {data?: {data: Array<BothProjectsRow>}; error?: unknown},
          'Failed to fetch both-assessed per-project counts',
        )
        return result.data
      },
      staleTime: 10_000,
    }
  })

  const projectRows = () => {
    return overviewQuery.data?.projects ?? []
  }
  const userRows = () => {
    return overviewQuery.data?.users ?? []
  }

  const bothProjectsById = () => {
    const rows = bothProjectsQuery.data ?? []
    return rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.projectId] = row.count
      return acc
    }, {})
  }
  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto">
      <div class="flex items-center justify-between mb-6">
        <h1 class="text-2xl font-bold">Human Assessments Overview</h1>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
          <div class="text-sm text-gray-500">Projects with assessments</div>
          <div class="text-2xl font-semibold text-gray-900">{projectRows().length}</div>
        </div>
        <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
          <div class="text-sm text-gray-500">Local assessors</div>
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
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Project
                  </th>
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Articles Assessed
                  </th>
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Assessed by Both
                  </th>
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
                          <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                            {bothProjectsById()[row.projectId] ?? 0}
                          </td>
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
            <h2 class="text-lg font-semibold">Local User</h2>
          </div>
          <div class="overflow-x-auto">
            <table class="min-w-full divide-y divide-gray-200">
              <thead class="bg-gray-50">
                <tr>
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">User</th>
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Articles Assessed
                  </th>
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
    </div>
  )
}

export const Route = createFileRoute('/admin/assessments/')({component: AdminAssessments})
