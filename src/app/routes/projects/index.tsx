import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {createSignal, Show} from 'solid-js'

import {ProjectsGrid} from '../../../components/main/ProjectsGrid'
import {ProjectStatistics} from '../../../components/main/ProjectStatistics'
import {Button} from '../../../components/ui/button'
import {deleteProject, fetchProjects} from '../../../services/projectsService'

const Projects = () => {
  const projects = useQuery(() => {
    return {queryKey: ['projects'], queryFn: fetchProjects}
  })
  const [deletingProject, setDeletingProject] = createSignal<string | null>(
    null,
  )

  const handleDeleteProject = async (
    projectId: string,
    projectName: string,
  ) => {
    if (
      !confirm(
        `Are you sure you want to delete the project "${projectName}"? This action cannot be undone.`,
      )
    ) {
      return
    }

    setDeletingProject(projectId)
    try {
      await deleteProject(projectId)
      await projects.refetch()
    } catch (error) {
      console.error('Failed to delete project:', error)
      alert(
        `Failed to delete project: ${error instanceof Error ? error.message : 'Unknown error'}`,
      )
    } finally {
      setDeletingProject(null)
    }
  }

  return (
    <div class="p-6 max-w-6xl mx-auto">
      <div class="flex justify-between items-center mb-6">
        <h1 class="text-3xl font-bold">Projects</h1>
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
        <ProjectsGrid
          projects={projects.data || []}
          deletingProject={deletingProject}
          handleDeleteProject={handleDeleteProject}
        />

        <ProjectStatistics projectCount={projects.data?.length || 0} />
      </Show>
    </div>
  )
}

export const Route = createFileRoute('/projects/')({component: Projects})
