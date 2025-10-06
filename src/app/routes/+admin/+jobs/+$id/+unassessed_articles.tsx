import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {Show} from 'solid-js'

import {UnassessedArticlesTable} from '../../../../../components/main/unassessedArticles/unassessedArticlesTable.tsx'
import {getJudgmentsJobUnassessedArticles} from '../../../../../services/judgmentsJobsService'

const buildUnassessedArticlesQuery = (jobIdAccessor: () => string | undefined) => {
  return {
    queryKey: ['judgments-job-unassessed-articles', jobIdAccessor()],
    queryFn: async () => {
      const id = jobIdAccessor()

      if (!id) {
        return []
      }

      return getJudgmentsJobUnassessedArticles(id)
    },
    enabled: Boolean(jobIdAccessor()),
    refetchInterval: 30_000,
  }
}

const AdminJobUnassessedArticles = () => {
  const params = Route.useParams()

  const jobId = () => {
    return params().id
  }

  const unassessedArticles = useQuery(() => {
    return buildUnassessedArticlesQuery(jobId)
  })

  const totalArticles = () => {
    return unassessedArticles.data?.length ?? 0
  }

  return (
    <div class="min-h-screen bg-gray-50 p-6">
      <div class="max-w-5xl mx-auto space-y-6">
        <div class="flex flex-col gap-2">
          <Link
            to={`/admin/jobs/${jobId()}`}
            class="text-blue-600 hover:text-blue-800 text-sm flex items-center gap-1"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M15 19l-7-7 7-7" />
            </svg>
            Back to Job
          </Link>
          <div>
            <h1 class="text-2xl font-bold text-gray-900">Unassessed Articles</h1>
            <p class="text-sm text-gray-500">Job ID: {jobId()}</p>
          </div>
        </div>

        <Show when={unassessedArticles.isLoading}>
          <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-8">
            <p class="text-gray-500 text-center">Loading unassessed articles...</p>
          </div>
        </Show>

        <Show when={unassessedArticles.isError}>
          <div class="p-4 rounded-md bg-red-50 border border-red-200">
            <p class="text-red-600">Failed to load unassessed articles</p>
            <button
              onClick={() => {
                return void unassessedArticles.refetch()
              }}
              class="mt-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
            >
              Retry
            </button>
          </div>
        </Show>

        <Show when={!unassessedArticles.isLoading && !unassessedArticles.isError}>
          <Show when={totalArticles() > 0} fallback={<div class="text-gray-500">No unassessed articles found.</div>}>
            <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-4 space-y-4">
              <div class="flex justify-between items-center">
                <h2 class="text-lg font-semibold text-gray-900">Articles awaiting assessment</h2>
                <span class="text-sm text-gray-600">{totalArticles()} articles</span>
              </div>
              <div class="overflow-x-auto">
                <UnassessedArticlesTable articles={unassessedArticles.data ?? []} />
              </div>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/admin/jobs/$id/unassessed_articles')({component: AdminJobUnassessedArticles})
