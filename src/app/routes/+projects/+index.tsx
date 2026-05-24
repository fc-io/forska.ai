import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {Match, Show, Switch} from 'solid-js'

import {ProjectsGrid} from '../../../components/main/projectsGrid'
import {Button} from '../../../components/ui/button'
import {apiClient} from '../../../services/apiClient'
import {fetchProjects} from '../../../services/projectsService'
import {handleApiResponse} from '../../../services/utils/handleApiResponse'
import {fetchProviderConnections} from '../+admin/+models/providerConnectionsClient.ts'

type ModelOption = {id: string}
type ModelsResponse = {data: ModelOption[]}
type ProviderSetupState = 'missing-model' | 'missing-provider'

const fetchSelectableModels = async () => {
  const response = await apiClient.api.models.get()
  const result = handleApiResponse<ModelsResponse>(
    response as unknown as {data?: ModelsResponse; error?: unknown; status?: number},
    'Failed to load models',
  )

  return result.data ?? []
}

export const ProjectsPage = () => {
  const projects = useQuery(() => {
    return {queryKey: ['projects'], queryFn: fetchProjects, staleTime: 5 * 60 * 1000, refetchOnMount: 'always'}
  })
  const providerConnections = useQuery(() => {
    return {
      queryKey: ['provider-connections'],
      queryFn: fetchProviderConnections,
      staleTime: 60 * 1000,
      suspense: false,
    }
  })
  const selectableModels = useQuery(() => {
    return {queryKey: ['models'], queryFn: fetchSelectableModels, staleTime: 5 * 60 * 1000, suspense: false}
  })
  const providerSetupState = (): ProviderSetupState | null => {
    if (
      providerConnections.isLoading
      || providerConnections.isError
      || selectableModels.isLoading
      || selectableModels.isError
    ) {
      return null
    }
    if ((providerConnections.data?.connections.length ?? 0) === 0) {
      return 'missing-provider'
    }
    if ((selectableModels.data?.length ?? 0) === 0) {
      return 'missing-model'
    }
    return null
  }

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto">
      <div class="flex flex-wrap justify-between items-center mb-6 gap-4">
        <h1 class="text-2xl font-bold">Projects</h1>
        <div class="flex gap-2 flex-wrap justify-end">
          <Button as={Link} to="/projects/archived" variant="outline">
            Show Archived
          </Button>
          <Button as={Link} to="/projects/create-subproject" variant="outline">
            Create Subproject
          </Button>
          <Button
            as={Link}
            to="/admin/datasources/covidence-import"
            variant="outline"
            class="border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 hover:text-amber-700 focus:ring-amber-500"
          >
            Create Covidence Project
          </Button>
          <Button as={Link} to="/projects/create">
            Create New Project
          </Button>
        </div>
      </div>

      <Switch>
        <Match when={providerSetupState() === 'missing-provider'}>
          <div class="text-center py-12 mb-6 rounded-lg border border-dashed border-gray-300 bg-white">
            <h2 class="text-xl font-semibold mb-4">No providers configured</h2>
            <p class="text-muted-foreground mb-6">
              Add a provider and enable at least one model before creating a project.
            </p>
            <Button as={Link} to="/providers/add-provider">
              Add Provider
            </Button>
          </div>
        </Match>
        <Match when={providerSetupState() === 'missing-model'}>
          <div class="text-center py-12 mb-6 rounded-lg border border-dashed border-gray-300 bg-white">
            <h2 class="text-xl font-semibold mb-4">No models available</h2>
            <p class="text-muted-foreground mb-6">Open Providers to sync or add a model for an enabled provider.</p>
            <Button as={Link} to="/providers">
              Manage Providers
            </Button>
          </div>
        </Match>
      </Switch>

      <Show when={!projects.isLoading} fallback={<div class="text-center py-8">Loading projects...</div>}>
        <Show when={projects.isError}>
          <div class="text-center py-8 text-red-600">
            Error loading projects: {projects.error instanceof Error ? projects.error.message : 'Unknown error'}
          </div>
        </Show>

        <Show when={!projects.isError && (projects.data?.length ?? 0) === 0}>
          <div class="text-center py-12">
            <h2 class="text-xl font-semibold mb-4">No projects found</h2>
            <p class="text-muted-foreground mb-6">Get started by creating your first project.</p>
            <Button as={Link} to="/projects/create">
              Create Your First Project
            </Button>
          </div>
        </Show>

        <Show when={!projects.isError && (projects.data?.length ?? 0) > 0}>
          <ProjectsGrid projects={projects.data ?? []} />
        </Show>
      </Show>
    </div>
  )
}

export const Route = createFileRoute('/projects/')({component: ProjectsPage})
