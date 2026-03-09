import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {Show} from 'solid-js'

import {ComparisonProjectsGrid} from '../../../../components/main/comparisonProjectsGrid'
import {Button} from '../../../../components/ui/button'
import {fetchArchivedComparisonProjects} from '../../../../services/comparisonProjectsService'

export const ArchivedCompareJudgmentsPage = () => {
  const comparisonProjects = useQuery(() => {
    return {queryKey: ['comparison-projects', 'archived'], queryFn: fetchArchivedComparisonProjects, suspense: false}
  })

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto">
      <div class="flex justify-between items-center mb-6">
        <div class="flex items-center gap-4">
          <Button as={Link} to="/compare-judgments" variant="outline" size="sm">
            ← Back to Compare Judgments
          </Button>
          <h1 class="text-2xl font-bold">Archived Comparison Projects</h1>
        </div>
      </div>

      <Show
        when={!comparisonProjects.isLoading}
        fallback={<div class="text-center py-8">Loading archived comparison projects...</div>}
      >
        <Show when={comparisonProjects.isError}>
          <div class="text-center py-8 text-red-600">
            Error loading archived comparison projects:{' '}
            {comparisonProjects.error instanceof Error ? comparisonProjects.error.message : 'Unknown error'}
          </div>
        </Show>

        <Show when={!comparisonProjects.isError && (comparisonProjects.data?.length ?? 0) === 0}>
          <div class="text-center py-12">
            <h2 class="text-xl font-semibold mb-4">No archived comparison projects</h2>
            <p class="text-muted-foreground mb-6">
              Comparison projects that you archive will appear here. You can archive them from the main list.
            </p>
            <Button as={Link} to="/compare-judgments">
              Back to Compare Judgments
            </Button>
          </div>
        </Show>

        <Show when={!comparisonProjects.isError && (comparisonProjects.data?.length ?? 0) > 0}>
          <ComparisonProjectsGrid
            comparisonProjects={comparisonProjects.data ?? []}
            isArchived
            onChange={() => {
              void comparisonProjects.refetch()
            }}
          />
        </Show>
      </Show>
    </div>
  )
}

export const Route = createFileRoute('/compare-judgments/archived/')({component: ArchivedCompareJudgmentsPage})
