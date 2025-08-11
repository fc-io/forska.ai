import {createFileRoute, Link} from '@tanstack/solid-router'
import {createResource, createSignal, For, Show} from 'solid-js'

import {Button} from '../../../components/ui/button'
import {
  deleteProject,
  fetchProjects,
  // fetchProjectStats,
} from '../../../services/projectsService'

const Projects = () => {
  const [projects, {refetch}] = createResource(fetchProjects)
  // const [projectStats] = createResource(fetchProjectStats)
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
      await refetch()
    } catch (error) {
      console.error('Failed to delete project:', error)
      alert(
        `Failed to delete project: ${error instanceof Error ? error.message : 'Unknown error'}`,
      )
    } finally {
      setDeletingProject(null)
    }
  }

  const totalActiveProjects = () => {
    return projects()?.length || 0
  }
  // const totalJudgments = () => {
  //   const stats = projectStats()
  //   if (!stats) return 0
  //   return stats.reduce((sum, stat) => {
  //     const judgments =
  //       typeof stat.total_judgments === 'number' ? stat.total_judgments : 0
  //     return sum + judgments
  //   }, 0)
  // }

  const formatDate = (dateString: string | null) => {
    if (!dateString) return 'Never'
    return new Date(dateString).toLocaleString()
  }

  return (
    <div class="p-6 max-w-6xl mx-auto">
      <div class="flex justify-between items-center mb-6">
        <h1 class="text-3xl font-bold">Projects</h1>
        <Button as={Link} href="/projects/create">
          Create New Project
        </Button>
      </div>

      <Show when={projects.loading}>
        <div class="text-center py-8">Loading projects...</div>
      </Show>

      <Show when={projects.error}>
        <div class="text-center py-8 text-red-600">
          Error loading projects:{' '}
          {projects.error instanceof Error
            ? projects.error.message
            : 'Unknown error'}
        </div>
      </Show>

      <Show when={projects() && projects()?.length === 0}>
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
          projects()
          && Array.isArray(projects())
          && (projects()?.length ?? 0) > 0
        }
      >
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
          {}
          <For each={projects()}>
            {(project) => {
              return (
                <div class="bg-card border rounded-lg p-6 shadow-sm">
                  <h3 class="text-xl font-semibold mb-3">{project.name}</h3>
                  <p class="text-muted-foreground mb-4">
                    {project.description || 'No description provided'}
                  </p>
                  <div class="flex items-center gap-2 mb-3">
                    <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
                      Active
                    </span>
                    <span class="text-sm text-muted-foreground">
                      Created {formatDate(project.inserted_at)}
                    </span>
                  </div>
                  <div class="flex gap-2">
                    <Button
                      as={Link}
                      href={`/projects/${project.id}`}
                      size="sm"
                      class="px-3 py-1 text-sm"
                    >
                      View Details
                    </Button>
                    <Button
                      as={Link}
                      href={`/projects/${project.id}/edit`}
                      variant="outline"
                      size="sm"
                      class="px-3 py-1 text-sm"
                    >
                      Edit
                    </Button>
                    <button
                      class="px-3 py-1 text-sm border border-red-200 text-red-600 rounded hover:bg-red-50 hover:border-red-300 disabled:opacity-50 disabled:cursor-not-allowed"
                      disabled={deletingProject() === project.id}
                      onClick={() => {
                        void handleDeleteProject(project.id, project.name)
                      }}
                    >
                      {deletingProject() === project.id
                        ? 'Deleting...'
                        : 'Delete'}
                    </button>
                  </div>
                </div>
              )
            }}
          </For>
        </div>

        <div class="bg-card border rounded-lg p-6">
          <h2 class="text-2xl font-semibold mb-4">Project Statistics</h2>
          <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div class="text-center">
              <div class="text-2xl font-bold text-primary">
                {totalActiveProjects()}
              </div>
              <div class="text-sm text-muted-foreground">Active Projects</div>
            </div>
            <div class="text-center">
              <div class="text-2xl font-bold text-primary">
                {/* {totalJudgments()} */}
              </div>
              <div class="text-sm text-muted-foreground">Total Judgments</div>
            </div>
            <div class="text-center">
              <div class="text-2xl font-bold text-primary">-</div>
              <div class="text-sm text-muted-foreground">In Queue</div>
            </div>
            <div class="text-center">
              <div class="text-2xl font-bold text-primary">-</div>
              <div class="text-sm text-muted-foreground">Success Rate</div>
            </div>
          </div>
        </div>
      </Show>
    </div>
  )
}

export const Route = createFileRoute('/projects/')({component: Projects})
