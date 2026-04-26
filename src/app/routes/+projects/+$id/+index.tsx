import {useQuery, useQueryClient} from '@tanstack/solid-query'
import {createFileRoute, Link, useNavigate} from '@tanstack/solid-router'
import {format} from 'date-fns'
import {createSignal, Match, Suspense, Switch} from 'solid-js'

import {ProjectDetailsCuratedArticles} from '../../../../components/main/projectDetails/projectDetailsCuratedArticles'
import {ProjectDetailsInformation} from '../../../../components/main/projectDetails/projectDetailsInformation'
import {ProjectDetailsPrompts} from '../../../../components/main/projects/projectDetailsPrompts'
import {Button} from '../../../../components/ui/button'
import {archiveProject, fetchProjectWithPrompts} from '../../../../services/projectsService'
import {getSglangRuntimeModelNotice} from '../../../../utils/getSglangRuntimeModelNotice.ts'
import {fetchProviderConnections} from '../../+admin/+models/providerConnectionsClient.ts'
import {useArchivedProjectRedirect, useProjectAccessQuery} from '../projectAccessGuard'

const ProjectDetail = () => {
  const params = Route.useParams()
  const projectId = (params() as {id: string}).id
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [archivingProject, setArchivingProject] = createSignal(false)
  const projectAccessQuery = useProjectAccessQuery(() => {
    return projectId
  })

  useArchivedProjectRedirect(projectAccessQuery)

  const projectData = useQuery(() => {
    return {
      queryKey: ['project', projectId, 'with-prompts'],
      queryFn: () => {
        return fetchProjectWithPrompts(projectId)
      },
      enabled: projectAccessQuery.data !== undefined && !projectAccessQuery.data.archived,
      refetchOnWindowFocus: false,
      staleTime: 5 * 60 * 1000,
    }
  })
  const providerConnectionsQuery = useQuery(() => {
    return {
      queryKey: ['provider-connections', 'project-detail', projectId],
      queryFn: fetchProviderConnections,
      staleTime: 60 * 1000,
      suspense: false,
    }
  })

  const formatDate = (dateString: string | null) => {
    if (!dateString) return 'Never'
    return format(new Date(dateString), 'PPpp')
  }

  const handleArchiveProject = async () => {
    const projectName = projectData.data?.project?.name ?? 'this project'
    if (
      !confirm(
        `Are you sure you want to archive the project "${projectName}"? The project will be hidden from project lists but can be restored later.`,
      )
    ) {
      return
    }

    setArchivingProject(true)
    try {
      await archiveProject(queryClient, projectId)
      void navigate({to: '/projects'})
    } catch (error) {
      console.error('Failed to archive project:', error)
      alert(`Failed to archive project: ${error instanceof Error ? error.message : 'Unknown error'}`)
    } finally {
      setArchivingProject(false)
    }
  }

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto">
      <div class="flex justify-between items-center mb-6">
        {/* Title Section */}
        <div class="flex items-center gap-4">
          <Button as={Link} to="/projects" variant="outline" size="sm">
            ← Back to Projects
          </Button>
          <h1 class="text-2xl font-bold">Project Details</h1>
          <span class="text-sm text-gray-500">ID: {projectId}</span>
        </div>

        {/* Navigation Buttons */}
        <div class="flex gap-2">
          <Button as={Link} to="/projects/$id/reviews-llm" params={{id: projectId} as never} variant="outline">
            Project Reviews
          </Button>
          <Switch>
            <Match when={projectAccessQuery.data?.humanJudgmentMode !== 'summary'}>
              <Button as={Link} to="/projects/$id/humanAssessment" params={{id: projectId} as never} variant="outline">
                Human Assessment
              </Button>
            </Match>
          </Switch>
          <Button as={Link} to="/projects/$id/edit" params={{id: projectId} as never}>
            Edit Project
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              return void handleArchiveProject()
            }}
          >
            {archivingProject() ? 'Archiving...' : 'Archive Project'}
          </Button>
        </div>
      </div>

      {/* Main Content */}
      <Switch>
        <Match when={projectAccessQuery.isLoading || projectAccessQuery.data?.archived}>
          <div class="text-center py-8">Loading project details...</div>
        </Match>
        <Match when={projectAccessQuery.isError}>
          <div class="text-center py-8 text-red-600">
            Error loading project:{' '}
            {projectAccessQuery.error instanceof Error
              ? projectAccessQuery.error.message
              : String(projectAccessQuery.error)}
          </div>
        </Match>
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
            const providerModel = model?.id
              ? (providerConnectionsQuery.data?.connections
                  .flatMap((connection) => {
                    return connection.models
                  })
                  .find((candidate) => {
                    return candidate.id === model.id
                  }) ?? null)
              : null
            const modelRuntimeNotice = providerModel
              ? getSglangRuntimeModelNotice({
                  candidateModelNames: [providerModel.remoteModelId, providerModel.modelName],
                  getMismatchMessage: (runtimeLabel) => {
                    return `Active SGLang runtime model: ${runtimeLabel}. Starting a job will be blocked until it matches this project's model.`
                  },
                  providerKind: providerModel.provider,
                  runtime: providerConnectionsQuery.data?.runtime ?? null,
                })
              : null
            const importRoutes = Array.isArray((result as {importRoutes?: unknown}).importRoutes)
              ? (result as {importRoutes: string[]}).importRoutes
              : []
            const namesByRouteCandidate = (result as {importRouteNamesByRoute?: unknown}).importRouteNamesByRoute
            const importRouteNamesByRoute =
              namesByRouteCandidate
              && typeof namesByRouteCandidate === 'object'
              && !Array.isArray(namesByRouteCandidate)
                ? (namesByRouteCandidate as Record<string, string | null>)
                : undefined

            type RawPrompt = {
              id: string
              createdAt?: Date | null
              updatedAt?: Date | null
              originalText: string
              transformedText: string | null
              promptHeading: string | null
              provider?: string | null
              modelName?: string | null
              order: number | null
              archived: boolean
              promptArchived?: boolean
              type: string | null
              enabled?: boolean
              originProjectId?: string | null
              linkedToProject?: boolean
            }

            const visibleRawPrompts = rawPrompts.filter((p: RawPrompt) => {
              const isArchived = Boolean(p.promptArchived)
              const isEnabled = p.enabled !== false
              const isLinkedToProject = p.linkedToProject ?? p.order !== null
              return !isArchived || isEnabled || isLinkedToProject
            })

            const prompts = visibleRawPrompts.map((p: RawPrompt) => {
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
                archived: p.promptArchived ?? undefined,
                enabled: p.enabled ?? true,
                originProjectId: p.originProjectId ?? null,
                linkedToProject: p.linkedToProject ?? p.order !== null,
              }
            })
            return (
              <div class="space-y-4">
                {/* Project Information - Suspense Boundary */}
                <Suspense
                  fallback={
                    <div class="bg-white rounded-lg shadow p-6 animate-pulse">
                      <div class="h-6 bg-gray-200 rounded w-1/4 mb-4" />
                      <div class="h-4 bg-gray-200 rounded w-1/2" />
                    </div>
                  }
                >
                  <ProjectDetailsInformation
                    project={project}
                    importRoutes={importRoutes}
                    importRouteNamesByRoute={importRouteNamesByRoute}
                    model={model}
                    modelRuntimeNotice={modelRuntimeNotice}
                  />
                </Suspense>

                {/* Project Prompts - Suspense Boundary */}
                <Suspense
                  fallback={
                    <div class="bg-white rounded-lg shadow p-6 animate-pulse">
                      <div class="h-6 bg-gray-200 rounded w-1/4 mb-4" />
                      <div class="h-4 bg-gray-200 rounded w-3/4" />
                    </div>
                  }
                >
                  <ProjectDetailsPrompts projectId={project.id} prompts={prompts} formatDate={formatDate} />
                </Suspense>

                {/* Curated Articles - Suspense Boundary */}
                <Suspense
                  fallback={
                    <div class="bg-white rounded-lg shadow p-6 animate-pulse">
                      <div class="h-6 bg-gray-200 rounded w-1/4 mb-4" />
                      <div class="h-4 bg-gray-200 rounded w-2/3" />
                    </div>
                  }
                >
                  <ProjectDetailsCuratedArticles projectId={projectId} />
                </Suspense>
              </div>
            )
          }}
        </Match>
      </Switch>
    </div>
  )
}

export const Route = createFileRoute('/projects/$id/')({component: ProjectDetail})
