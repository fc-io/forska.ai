import {Link} from '@tanstack/solid-router'
import {format} from 'date-fns'
import {createSignal, For} from 'solid-js'

import {deleteProject} from '../../services/projectsService'
import {Button} from '../ui/button'

interface Project {
  id: string
  name: string
  description: string | null
  createdAt: Date
}

interface IndexProjectsGridProps {
  projects: Project[]
  refetch: () => Promise<void>
}

export const ProjectsGrid = (props: IndexProjectsGridProps) => {
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
      await props.refetch()
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
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
      {}
      <For each={props.projects}>
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
                  Created: {format(project.createdAt, 'yyyy-MM-dd HH:mm')}
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
                <Button
                  variant="outline"
                  size="sm"
                  class="px-3 py-1 text-sm"
                  onClick={() => {
                    console.log('Run agent for project:', project.id)
                  }}
                >
                  Run agent
                </Button>
                <button
                  class="px-3 py-1 text-sm border border-red-200 text-red-600 rounded hover:bg-red-50 hover:border-red-300 disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={deletingProject() === project.id}
                  onClick={() => {
                    void handleDeleteProject(project.id, project.name)
                  }}
                >
                  {deletingProject() === project.id ? 'Deleting...' : 'Delete'}
                </button>
              </div>
            </div>
          )
        }}
      </For>
    </div>
  )
}
