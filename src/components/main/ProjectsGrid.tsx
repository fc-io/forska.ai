import {Link} from '@tanstack/solid-router'
import {format} from 'date-fns'
import {For} from 'solid-js'

import {Button} from '../ui/button'
import {runJudge} from './projectsGrid/projectGridRunJudge'

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
                  variant="outline"
                  size="sm"
                  class="px-3 py-1 text-sm"
                >
                  View Details
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
                <Button
                  size="sm"
                  class="px-3 py-1 text-sm"
                  onClick={() => {
                    console.log('Run agent for project:', project.id)
                    void runJudge({
                      numberOfArticlesToGet: 3,
                      projectId: project.id,
                    })
                  }}
                >
                  Run agent
                </Button>
              </div>
            </div>
          )
        }}
      </For>
    </div>
  )
}
