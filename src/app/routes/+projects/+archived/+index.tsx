import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {Show} from 'solid-js'

import {ProjectsGrid} from '../../../../components/main/ProjectsGrid'
import {Button} from '../../../../components/ui/button'
import {fetchArchivedProjects} from '../../../../services/projectsService'

export const ArchivedProjectsPage = () => {
  const projects = useQuery(() => {
    return {queryKey: ['projects', 'archived'], queryFn: fetchArchivedProjects}
  })

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto">
      <div class="flex justify-between items-center mb-6">
        <div class="flex items-center gap-4">
          <Button as={Link} to="/projects" variant="outline" size="sm">
            ← Back to Projects
          </Button>
          <h1 class="text-2xl font-bold">Archived Projects</h1>
        </div>
      </div>

      <Show when={!projects.isLoading} fallback={<div class="text-center py-8">Loading archived projects...</div>}>
        <Show when={projects.isError}>
          <div class="text-center py-8 text-red-600">
            Error loading archived projects:{' '}
            {projects.error instanceof Error ? projects.error.message : 'Unknown error'}
          </div>
        </Show>

        <Show when={!projects.isError && (projects.data?.length ?? 0) === 0}>
          <div class="text-center py-12">
            <h2 class="text-xl font-semibold mb-4">No archived projects</h2>
            <p class="text-muted-foreground mb-6">
              Projects that you archive will appear here. You can archive a project from its details page.
            </p>
            <Button as={Link} to="/projects">
              Back to Projects
            </Button>
          </div>
        </Show>

        <Show when={!projects.isError && (projects.data?.length ?? 0) > 0}>
          <ProjectsGrid
            projects={projects.data ?? []}
            isArchived
            onUnarchive={() => {
              void projects.refetch()
            }}
          />
        </Show>
      </Show>
    </div>
  )
}

export const Route = createFileRoute('/projects/archived/')({component: ArchivedProjectsPage})
