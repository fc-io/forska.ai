import {useQuery} from '@tanstack/solid-query'
import {Link} from '@tanstack/solid-router'
import {format} from 'date-fns'
import {createSignal, For} from 'solid-js'

import {fetchSession} from '../../services/fetchSession'
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
  const sessionQuery = useQuery(() => {
    return {
      queryKey: ['session'],
      queryFn: fetchSession,
      staleTime: 1000 * 60 * 1, // Consider data fresh for 5 minutes
      // refetchInterval: 1000 * 60 * 5, // Refetch every 5 minutes
      // refetchIntervalInBackground: true,
      // refetchOnWindowFocus: true,
    }
  })
  // const t = () => {
  //   return console.log('sessionQuery.data', sessionQuery.data.session.id)
  // }
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
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
      {}
      <For each={props.projects}>
        {(project) => {
          return (
            <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
              <Link
                to={`/projects/${project.id}/reviews`}
                class="text-xl font-semibold mb-3 block text-blue-600 hover:text-blue-800 underline decoration-2 underline-offset-2 transition-colors"
              >
                {project.name}
              </Link>
              <p class="text-muted-foreground mb-4">
                {(project.description && project.description.length > 100
                  ? `${project.description?.slice(0, 100).trim()}…`
                  : project.description) || 'No description provided'}
              </p>
              <div class="flex items-center gap-2 mb-3">
                <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
                  Active
                </span>
                <span class="text-sm text-muted-foreground">
                  Created: {format(project.createdAt, 'yyyy-MM-dd HH:mm')}
                </span>
              </div>
              <div class="flex flex-col gap-2">
                <div class="flex gap-2">
                  <Button
                    as={Link}
                    href={`/projects/${project.id}`}
                    variant="outline"
                    size="sm"
                    class="px-3 py-1 text-sm"
                  >
                    Project Details
                </Button>
                  <Button
                    as={Link}
                    href={`/projects/${project.id}/edit`}
                    size="sm"
                    variant="outline"
                    class="px-3 py-1 text-sm"
                  >
                    Edit
                  </Button>
                </div>
                <div class="flex gap-2">
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
            </div>
          )
        }}
      </For>
    </div>
  )
}
