import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link, useNavigate} from '@tanstack/solid-router'
import {createSignal, Match, Show, Switch} from 'solid-js'

import {ProjectDetailsArticles} from '../../../../components/main/projectDetailsArticles'
import {ProjectDetailsPrompts} from '../../../../components/main/projects/projectDetailsPrompts'
import {Button} from '../../../../components/ui/button'
import {
  deleteProject,
  fetchProjectWithPrompts,
} from '../../../../services/projectsService'

const ProjectDetail = () => {
  const params = Route.useParams()
  const projectId = (params() as {id: string}).id
  const navigate = useNavigate()
  const [deletingProject, setDeletingProject] = createSignal(false)
  const projectData = useQuery(() => {
    return {
      queryKey: ['project', projectId, 'with-prompts'],
      queryFn: () => {
        return fetchProjectWithPrompts(projectId)
      },
    }
  })

  const formatDate = (dateString: string | null) => {
    if (!dateString) return 'Never'
    return new Date(dateString).toLocaleString()
  }

  const handleDeleteProject = async () => {
    const projectName = projectData.data?.project.name
    if (
      !confirm(
        `Are you sure you want to delete the project "${projectName}"? This action cannot be undone.`,
      )
    ) {
      return
    }

    setDeletingProject(true)
    try {
      await deleteProject(projectId)
      void navigate({to: '/projects'})
    } catch (error) {
      console.error('Failed to delete project:', error)
      alert(
        `Failed to delete project: ${error instanceof Error ? error.message : 'Unknown error'}`,
      )
    } finally {
      setDeletingProject(false)
    }
  }

  return (
    <div class="p-6 max-w-4xl mx-auto">
      <div class="flex justify-between items-center mb-6">
        <div class="flex items-center gap-4">
          <Button as={Link} href="/projects" variant="outline" size="sm">
            ← Back to Projects
          </Button>
          <h1 class="text-3xl font-bold">Project Details</h1>
        </div>
        <Show when={projectData.isSuccess}>
          <div class="flex gap-2">
            <Button as={Link} href={`/projects/${projectId}/edit`}>
              Edit Project
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                return void handleDeleteProject()
              }}
              // eslint-disable-next-line solid/no-constant-condition
              disabled={true || deletingProject()}
            >
              {deletingProject() ? 'Deleting...' : 'Delete Project'}
            </Button>
          </div>
        </Show>
      </div>

      <Switch>
        <Match when={projectData.isLoading}>
          <div class="text-center py-8">Loading project details...</div>
        </Match>
        <Match when={projectData.isError}>
          <div class="text-center py-8 text-red-600">
            Error loading project:{' '}
            {projectData.error instanceof Error
              ? projectData.error.message
              : String(projectData.error)}
          </div>
        </Match>
        <Match when={projectData.data}>
          {(data) => {
            const {project, prompts: rawPrompts} = data()

            interface RawPrompt {
              id: string
              createdAt: Date
              updatedAt: Date
              projectId: string
              originalText: string
              transformedText: string | null
              promptHeading: string | null
              order: number | null
              archived: boolean
              type: string | null
            }

            const prompts = rawPrompts.map((p: RawPrompt) => {
              return {
                ...p,
                order: p.order ?? 0,
                promptHeading: p.promptHeading ?? undefined,
                type: p.type ?? undefined,
                created_at: p.createdAt.toString(),
                original_text: p.originalText,
                transformed_text: p.transformedText ?? undefined,
                archived: p.archived ?? undefined,
              }
            })
            return (
              <div class="space-y-8">
                {/* Project Information */}
                <div class="bg-card border rounded-lg p-6">
                  <h2 class="text-2xl font-semibold mb-4">
                    Project Information
                  </h2>
                  <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label class="text-sm font-medium text-muted-foreground">
                        Name
                      </label>
                      <p class="text-lg">{project.name}</p>
                    </div>
                    <div>
                      <label class="text-sm font-medium text-muted-foreground">
                        Created
                      </label>
                      <p class="text-lg">
                        {formatDate(project.createdAt?.toString())}
                      </p>
                    </div>
                    <div class="md:col-span-2">
                      <label class="text-sm font-medium text-muted-foreground">
                        Description
                      </label>
                      <p class="text-lg">
                        {project.description || 'No description provided'}
                      </p>
                    </div>
                    <div>
                      <label class="text-sm font-medium text-muted-foreground">
                        Last Updated
                      </label>
                      <p class="text-lg">
                        {formatDate(project.updatedAt?.toString())}
                      </p>
                    </div>
                    <div>
                      <label class="text-sm font-medium text-muted-foreground">
                        Status
                      </label>
                      <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
                        Active
                      </span>
                    </div>
                  </div>
                </div>

                {/* Prompts Section */}
                <ProjectDetailsPrompts
                  prompts={prompts}
                  formatDate={formatDate}
                />
              </div>
            )
          }}
        </Match>
      </Switch>
      <ProjectDetailsArticles projectId={projectId} />
    </div>
  )
}

export const Route = createFileRoute('/projects/$id/')({
  component: ProjectDetail,
})
