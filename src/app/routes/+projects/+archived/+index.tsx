import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {Show} from 'solid-js'

import {Button} from '../../../../components/ui/button'
import {fetchArchivedProjects} from '../../../../services/projectsService'
import {ArchivedProjectsTable} from './archivedProjectsTable'

export const ArchivedProjectsPage = () => {
  const projects = useQuery(() => {
    return {queryKey: ['projects', 'archived'], queryFn: fetchArchivedProjects}
  })

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto">
      <div class="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div class="flex items-center gap-4">
          <Button as={Link} to="/projects" variant="outline" size="sm">
            ← Back to Projects
          </Button>
          <div>
            <h1 class="text-2xl font-bold text-gray-900">Archived Projects</h1>
            <p class="mt-2 text-sm text-muted-foreground">
              Archived projects are kept out of the active workspace until you unarchive them.
            </p>
          </div>
        </div>
      </div>

      <Show
        when={!projects.isLoading}
        fallback={
          <div class="rounded-xl border border-gray-200 bg-white px-6 py-10 text-center">
            Loading archived projects...
          </div>
        }
      >
        <Show when={projects.isError}>
          <div class="rounded-xl border border-red-200 bg-red-50 px-6 py-10 text-center text-red-600">
            Error loading archived projects:{' '}
            {projects.error instanceof Error ? projects.error.message : 'Unknown error'}
          </div>
        </Show>

        <Show when={!projects.isError && (projects.data?.length ?? 0) === 0}>
          <div class="rounded-xl border border-gray-200 bg-white px-6 py-12 text-center">
            <h2 class="mb-4 text-xl font-semibold">No archived projects</h2>
            <p class="mb-6 text-muted-foreground">
              Projects that you archive will appear here. You can archive a project from its details page.
            </p>
            <Button as={Link} to="/projects">
              Back to Projects
            </Button>
          </div>
        </Show>

        <Show when={!projects.isError && (projects.data?.length ?? 0) > 0}>
          <ArchivedProjectsTable projects={projects.data ?? []} />
        </Show>
      </Show>
    </div>
  )
}

export const Route = createFileRoute('/projects/archived/')({component: ArchivedProjectsPage})
