import {Link} from '@tanstack/solid-router'
import {format} from 'date-fns'
import {createSignal, For} from 'solid-js'

import {createJudgmentsJob} from '../../services/judgmentsJobsService'
import {Button} from '../ui/button'

interface Project {
  id: string
  name: string
  description: string | null
  createdAt: Date
}

interface IndexProjectsGridProps {
  projects: Project[]
}

export const ProjectsGrid = (props: IndexProjectsGridProps) => {
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

  return (
    <ul class="flex flex-col gap-6 mb-8 list-none p-0">
      {}
      <For each={props.projects}>
        {(project) => {
          return (
            <li>
              <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                <div class="flex items-start justify-between gap-3 mb-3">
                  <h2 class="text-xl font-semibold">{project.name}</h2>
                  <div class="flex items-center gap-2">
                    <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
                      Active
                    </span>
                    <span class="text-sm text-muted-foreground">
                      Created: {format(project.createdAt, 'yyyy-MM-dd HH:mm')}
                    </span>
                  </div>
                </div>
                <p class="text-muted-foreground mb-4">
                  {(project.description && project.description.length > 100
                    ? `${project.description?.slice(0, 100).trim()}…`
                    : project.description) || 'No description provided'}
                </p>
                <div class="flex gap-2">
                  <Button
                    as={Link}
                    to="/projects/$id"
                    params={{id: project.id}}
                    variant="outline"
                    size="sm"
                    class="px-3 py-1 text-sm"
                  >
                    Project Details
                  </Button>
                  <Button
                    as={Link}
                    to="/projects/$id/reviews"
                    params={{id: project.id}}
                    variant="outline"
                    size="sm"
                    class="px-3 py-1 text-sm"
                  >
                    Project Reviews
                  </Button>
                  <Button
                    as={Link}
                    to="/projects/$id/humanAssessment"
                    params={{id: project.id}}
                    variant="outline"
                    size="sm"
                    class="px-3 py-1 text-sm"
                  >
                    Human Assessment
                  </Button>
                  <Button
                    as={Link}
                    to="/projects/$id/edit"
                    params={{id: project.id}}
                    size="sm"
                    variant="outline"
                    class="px-3 py-1 text-sm"
                  >
                    Edit
                  </Button>
                  <Button size="sm" variant="outline" class="px-3 py-1 text-sm">
                    Clone Project
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
                </div>
              </div>
            </li>
          )
        }}
      </For>
    </ul>
  )
}
