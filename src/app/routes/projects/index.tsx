import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {Show} from 'solid-js'

import {ProjectsGrid} from '../../../components/main/ProjectsGrid'
import {ProjectStatistics} from '../../../components/main/ProjectStatistics'
import {Button} from '../../../components/ui/button'
import {fetchProjects} from '../../../services/projectsService'

const Projects = () => {
  const projects = useQuery(() => {
    return {queryKey: ['projects'], queryFn: fetchProjects}
  })

  return (
    <div class="p-6 max-w-6xl mx-auto">
      <div class="flex justify-between items-center mb-6">
        <h1 class="text-2xl font-bold">Projects</h1>
        <Button as={Link} href="/projects/create">
          Create New Project
        </Button>
      </div>

      <Show when={projects.isLoading}>
        <div class="text-center py-8">Loading projects...</div>
      </Show>

      <Show when={projects.isError}>
        <div class="text-center py-8 text-red-600">
          Error loading projects:{' '}
          {projects.error instanceof Error
            ? projects.error.message
            : 'Unknown error'}
        </div>
      </Show>

      <Show when={projects.data && projects.data?.length === 0}>
        <div class="text-center py-12">
          <h2 class="text-xl font-semibold mb-4">No projects found</h2>
          <p class="text-muted-foreground mb-6">
            Get started by creating your first project.
          </p>
          <Button as={Link} href="/projects/create">
            Create Your First Project
          </Button>
        </div>
      </Show>

      <Show
        when={
          projects.data
          && Array.isArray(projects.data)
          && (projects.data?.length ?? 0) > 0
        }
      >
        <ProjectsGrid projects={projects.data || []} />
        <ProjectStatistics projectCount={projects.data?.length || 0} />
      </Show>
    </div>
  )
}

export const Route = createFileRoute('/projects/')({component: Projects})
