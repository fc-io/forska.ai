import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {Show} from 'solid-js'

import {ComparisonProjectsGrid} from '../../../components/main/comparisonProjectsGrid'
import {Button} from '../../../components/ui/button'
import {fetchComparisonProjects} from '../../../services/comparisonProjectsService'

export const CompareJudgmentsPage = () => {
  const comparisonProjects = useQuery(() => {
    return {queryKey: ['comparison-projects'], queryFn: fetchComparisonProjects, suspense: false}
  })

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto">
      <div class="flex justify-between items-center mb-6">
        <h1 class="text-2xl font-bold">Compare Judgments</h1>
        <div class="flex gap-2">
          <Button as={Link} to="/compare-judgments/archived" variant="outline">
            Show Archived
          </Button>
          <Button as={Link} to="/compare-judgments/create">
            Create New Comparison
          </Button>
        </div>
      </div>

      <Show
        when={!comparisonProjects.isLoading}
        fallback={<div class="text-center py-8">Loading comparison projects...</div>}
      >
        <Show when={comparisonProjects.isError}>
          <div class="text-center py-8 text-red-600">
            Error loading comparison projects:{' '}
            {comparisonProjects.error instanceof Error ? comparisonProjects.error.message : 'Unknown error'}
          </div>
        </Show>

        <Show when={!comparisonProjects.isError && (comparisonProjects.data?.length ?? 0) === 0}>
          <div class="text-center py-12">
            <h2 class="text-xl font-semibold mb-4">No comparison projects found</h2>
            <p class="text-muted-foreground mb-6">
              Create a comparison project to save prompts, routes, and content settings.
            </p>
            <Button as={Link} to="/compare-judgments/create">
              Create Comparison Project
            </Button>
          </div>
        </Show>

        <Show when={!comparisonProjects.isError && (comparisonProjects.data?.length ?? 0) > 0}>
          <ComparisonProjectsGrid
            comparisonProjects={comparisonProjects.data ?? []}
            onChange={() => {
              void comparisonProjects.refetch()
            }}
          />
        </Show>
      </Show>
    </div>
  )
}

export const Route = createFileRoute('/compare-judgments/')({component: CompareJudgmentsPage})
