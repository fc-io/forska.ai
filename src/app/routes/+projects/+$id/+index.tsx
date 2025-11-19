import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link, useNavigate} from '@tanstack/solid-router'
import {format} from 'date-fns'
import {createSignal, Match, Show, Suspense, Switch} from 'solid-js'

import {ProjectDetailsArticles} from '../../../../components/main/projectDetails/projectDetailsArticles'
import {ProjectDetailsCuratedArticles} from '../../../../components/main/projectDetails/projectDetailsCuratedArticles'
import {ProjectDetailsInformation} from '../../../../components/main/projectDetails/projectDetailsInformation'
import {ProjectDetailsPrompts} from '../../../../components/main/projects/projectDetailsPrompts'
import {Button} from '../../../../components/ui/button'
import {deleteProject, fetchProjectWithPrompts} from '../../../../services/projectsService'
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
      refetchOnWindowFocus: true,
    }
  })

  const formatDate = (dateString: string | null) => {
    if (!dateString) return 'Never'
    return format(new Date(dateString), 'PPpp')
  }

  const handleDeleteProject = async () => {
    const projectName = projectData.data?.project.name
    if (!confirm(`Are you sure you want to delete the project "${projectName}"? This action cannot be undone.`)) {
      return
    }

    setDeletingProject(true)
    try {
      await deleteProject(projectId)
      void navigate({to: '/projects'})
    } catch (error) {
      console.error('Failed to delete project:', error)
      alert(`Failed to delete project: ${error instanceof Error ? error.message : 'Unknown error'}`)
    } finally {
      setDeletingProject(false)
    }
  }

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto">
      <div class="flex justify-between items-center mb-6">
        <div class="flex items-center gap-4">
          <Button as={Link} to="/projects" variant="outline" size="sm">
            ← Back to Projects
          </Button>
          <h1 class="text-2xl font-bold">Project Details</h1>
          <span class="text-sm text-gray-500">ID: {projectId}</span>
        </div>
        <Show when={projectData.isSuccess}>
          <div class="flex gap-2">
            <Button as={Link} to="/projects/$id/reviews-both" params={{id: projectId}} variant="outline">
              Project Reviews
            </Button>
            <Button as={Link} to="/projects/$id/humanAssessment" params={{id: projectId}} variant="outline">
              Human Assessment
            </Button>
            <Button as={Link} to="/projects/$id/edit" params={{id: projectId}}>
              Edit Project
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                return void handleDeleteProject()
              }}
              // TODO: makke this check on the server side as well
              disabled={projectData.data?.hasJudgedArticles}
            >
              {deletingProject() ? 'Deleting...' : 'Delete Project'}
            </Button>
          </div>
        </Show>
      </div>

      <Suspense>
        <Switch>
          <Match when={projectData.isLoading}>
            <div class="text-center py-8">Loading project details...</div>
          </Match>
          <Match when={projectData.isError}>
            <div class="text-center py-8 text-red-600">
              Error loading project:{' '}
              {projectData.error instanceof Error ? projectData.error.message : String(projectData.error)}
            </div>
          </Match>
          <Match when={projectData.data}>
            {(data) => {
              const result = data()
              const {project, prompts: rawPrompts, model} = result
              const importRoutes = Array.isArray((result as {importRoutes?: unknown}).importRoutes)
                ? (result as {importRoutes: string[]}).importRoutes
                : []

              interface RawPrompt {
                id: string
                createdAt?: Date
                updatedAt?: Date
                projectId: string
                originalText: string
                transformedText: string | null
                promptHeading: string | null
                provider?: string | null
                modelName?: string | null
                order: number | null
                archived: boolean
                type: string | null
                enabled?: boolean
                originProjectId?: string | null
              }

              const prompts = rawPrompts.map((p: RawPrompt) => {
                return {
                  ...p,
                  order: p.order ?? 0,
                  promptHeading: p.promptHeading ?? undefined,
                  type: p.type ?? undefined,
                  created_at: p.createdAt?.toString() ?? new Date().toISOString(),
                  original_text: p.originalText,
                  transformed_text: p.transformedText ?? undefined,
                  provider: p.provider ?? null,
                  modelName: p.modelName ?? null,
                  archived: p.archived ?? undefined,
                  enabled: p.enabled ?? true,
                  originProjectId: p.originProjectId ?? null,
                }
              })
              return (
                <div class="space-y-4">
                  <ProjectDetailsInformation project={project} importRoutes={importRoutes} model={model} />
                  <ProjectDetailsPrompts projectId={project.id} prompts={prompts} formatDate={formatDate} />
                  <ProjectDetailsCuratedArticles projectId={projectId} />
                  <ProjectDetailsArticles projectId={projectId} />
                </div>
              )
            }}
          </Match>
        </Switch>
      </Suspense>
    </div>
  )
}

export const Route = createFileRoute('/projects/$id/')({component: ProjectDetail})
