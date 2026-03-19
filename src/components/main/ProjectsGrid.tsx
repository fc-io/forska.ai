import {useQueryClient} from '@tanstack/solid-query'
import {Link} from '@tanstack/solid-router'
import {format} from 'date-fns'
import {createMemo, createSignal, For, Show} from 'solid-js'

import {createJudgmentsJob} from '../../services/judgmentsJobsService'
import type {fetchProjects} from '../../services/projectsService'
import {cloneProject, unarchiveProject} from '../../services/projectsService'
import {Button} from '../ui/button'

type Project = Awaited<ReturnType<typeof fetchProjects>>[number]

interface IndexProjectsGridProps {
  projects: Project[]
  isArchived?: boolean
}

const getProjectModelLabel = (project: Project) => {
  return project.modelName || 'Unknown model'
}

const getProjectContentUsedLabel = (project: Project) => {
  const fulltextLabel = project.useFulltextNoImages ? 'fulltext (no images)' : project.useFulltext ? 'fulltext' : null
  const parts = [project.useTitle ? 'title' : null, project.useAbstract ? 'abstract' : null, fulltextLabel].filter(
    Boolean,
  ) as string[]

  return parts.length > 0 ? parts.join(', ') : 'none'
}

export const ProjectsGrid = (props: IndexProjectsGridProps) => {
  const queryClient = useQueryClient()
  const sortedProjects = createMemo(() => {
    return [...props.projects].sort((a, b) => {
      return a.name.localeCompare(b.name)
    })
  })

  const [creatingJobs, setCreatingJobs] = createSignal<Set<string>>(new Set())
  const handleCreateJudgmentsJob = async (projectId: string) => {
    setCreatingJobs((prev) => {
      return new Set([...prev, projectId])
    })
    try {
      const job = await createJudgmentsJob(projectId)
      console.log('Judgments job created:', job)
    } catch (error) {
      console.error('Failed to create judgments job:', error)
    } finally {
      setCreatingJobs((prev) => {
        const next = new Set(prev)
        next.delete(projectId)
        return next
      })
    }
  }

  const [cloningProjects, setCloningProjects] = createSignal<Set<string>>(new Set())
  const handleCloneProject = async (projectId: string) => {
    setCloningProjects((prev) => {
      return new Set([...prev, projectId])
    })
    try {
      const clonedProject = await cloneProject(projectId)
      console.log('Project cloned:', clonedProject)
      // Reload the page to show the new project
      window.location.reload()
    } catch (error) {
      console.error('Failed to clone project:', error)
    } finally {
      setCloningProjects((prev) => {
        const next = new Set(prev)
        next.delete(projectId)
        return next
      })
    }
  }

  const [unarchivingProjects, setUnarchivingProjects] = createSignal<Set<string>>(new Set())
  const handleUnarchiveProject = async (projectId: string) => {
    setUnarchivingProjects((prev) => {
      return new Set([...prev, projectId])
    })
    try {
      await unarchiveProject(queryClient, projectId)
      console.log('Project unarchived:', projectId)
    } catch (error) {
      console.error('Failed to unarchive project:', error)
    } finally {
      setUnarchivingProjects((prev) => {
        const next = new Set(prev)
        next.delete(projectId)
        return next
      })
    }
  }

  return (
    <ul class="flex flex-col gap-6 mb-8 list-none p-0">
      {}
      <For each={sortedProjects()}>
        {(project) => {
          return (
            <li>
              <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                <div class="flex items-start justify-between gap-3 mb-3">
                  <div class="flex flex-col gap-1 min-w-0">
                    <h2 class="text-xl font-semibold truncate">{project.name}</h2>
                    <p class="text-sm text-muted-foreground">
                      Model: {getProjectModelLabel(project)} · Content: {getProjectContentUsedLabel(project)}
                    </p>
                  </div>
                  <div class="flex items-center gap-2">
                    <Show
                      when={props.isArchived}
                      fallback={
                        <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
                          Active
                        </span>
                      }
                    >
                      <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
                        Archived
                      </span>
                    </Show>
                    <span class="text-sm text-muted-foreground">
                      Created: {project.createdAt ? format(project.createdAt, 'yyyy-MM-dd HH:mm') : 'Unknown'}
                    </span>
                  </div>
                </div>
                {project.description && (
                  <p class="text-muted-foreground mb-4">
                    {project.description.length > 100
                      ? `${project.description.slice(0, 100).trim()}…`
                      : project.description}
                  </p>
                )}
                <div class="flex gap-2">
                  <Show when={props.isArchived}>
                    <Button
                      size="sm"
                      class="px-3 py-1 text-sm"
                      disabled={unarchivingProjects().has(project.id)}
                      onClick={() => {
                        void handleUnarchiveProject(project.id)
                      }}
                    >
                      {unarchivingProjects().has(project.id) ? 'Unarchiving...' : 'Unarchive'}
                    </Button>
                  </Show>
                  <Show when={!props.isArchived}>
                    <Button
                      as={Link}
                      to="/projects/$id"
                      params={{id: project.id} as never}
                      variant="outline"
                      size="sm"
                      class="px-3 py-1 text-sm"
                    >
                      Project Details
                    </Button>
                    <Button
                      as={Link}
                      to="/projects/$id/reviews"
                      params={{id: project.id} as never}
                      variant="outline"
                      size="sm"
                      class="px-3 py-1 text-sm"
                    >
                      Project Reviews
                    </Button>
                    <Button
                      as={Link}
                      to="/projects/$id/humanAssessment"
                      params={{id: project.id} as never}
                      variant="outline"
                      size="sm"
                      class="px-3 py-1 text-sm"
                    >
                      Human Assessment
                    </Button>
                    <Button
                      as={Link}
                      to="/projects/$id/edit"
                      params={{id: project.id} as never}
                      size="sm"
                      variant="outline"
                      class="px-3 py-1 text-sm"
                    >
                      Edit
                    </Button>
                    <Button
                      as={Link}
                      to="/projects/$id/export"
                      params={{id: project.id} as never}
                      size="sm"
                      variant="outline"
                      class="px-3 py-1 text-sm"
                    >
                      Export data
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      class="px-3 py-1 text-sm"
                      disabled={cloningProjects().has(project.id)}
                      onClick={() => {
                        void handleCloneProject(project.id)
                      }}
                    >
                      {cloningProjects().has(project.id) ? 'Cloning...' : 'Clone Project'}
                    </Button>
                    <Button
                      size="sm"
                      class="px-3 py-1 text-sm"
                      disabled={creatingJobs().has(project.id)}
                      onClick={() => {
                        void handleCreateJudgmentsJob(project.id)
                      }}
                    >
                      {creatingJobs().has(project.id) ? 'Creating...' : 'Start Judgments Job'}
                    </Button>
                  </Show>
                </div>
              </div>
            </li>
          )
        }}
      </For>
    </ul>
  )
}
