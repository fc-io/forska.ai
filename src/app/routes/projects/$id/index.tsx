import {createFileRoute, Link} from '@tanstack/solid-router'
import {createResource, For, Match, Show, Switch} from 'solid-js'

import {Button} from '../../../../components/ui/button'
import {fetchProjectWithPrompts} from '../../../../services/projectsService'

const ProjectDetail = () => {
  const params = Route.useParams()
  const projectId = (params() as {id: string}).id
  const [projectData] = createResource(() => {
    return fetchProjectWithPrompts(projectId)
  })

  const formatDate = (dateString: string | null) => {
    if (!dateString) return 'Never'
    return new Date(dateString).toLocaleString()
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
        <Show when={projectData.state === 'ready'}>
          <Button as={Link} href={`/projects/${projectId}/edit`}>
            Edit Project
          </Button>
        </Show>
      </div>

      <Switch>
        <Match when={projectData.loading}>
          <div class="text-center py-8">Loading project details...</div>
        </Match>
        <Match when={projectData.error}>
          {(error) => {
            return (
              <div class="text-center py-8 text-red-600">
                Error loading project:{' '}
                {error() instanceof Error ? error().message : String(error())}
              </div>
            )
          }}
        </Match>
        <Match when={projectData()}>
          {(data) => {
            const {project, prompts} = data()
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
                      <p class="text-lg">{formatDate(project.inserted_at)}</p>
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
                      <p class="text-lg">{formatDate(project.updated_at)}</p>
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
                <div class="bg-card border rounded-lg p-6">
                  <div class="flex justify-between items-center mb-4">
                    <h2 class="text-2xl font-semibold">
                      Prompts ({prompts.length})
                    </h2>
                  </div>

                  <Show when={prompts.length === 0}>
                    <div class="text-center py-8 text-muted-foreground">
                      <p class="text-lg mb-2">
                        No prompts found for this project
                      </p>
                      <p class="text-sm">
                        Prompts will appear here once they are created.
                      </p>
                    </div>
                  </Show>

                  <Show when={prompts.length > 0}>
                    <div class="space-y-4">
                      <For each={prompts}>
                        {(prompt) => {
                          return (
                            <div class="border rounded-lg p-4 bg-background">
                              <div class="flex justify-between items-start mb-3">
                                <div class="flex items-center gap-2">
                                  <span class="inline-flex items-center justify-center w-6 h-6 rounded-full bg-primary text-primary-foreground text-xs font-medium">
                                    {prompt.order}
                                  </span>
                                  <span class="text-sm text-muted-foreground">
                                    Created {formatDate(prompt.created_at)}
                                  </span>
                                  <Show when={prompt.archived}>
                                    <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
                                      Archived
                                    </span>
                                  </Show>
                                </div>
                              </div>

                              <div class="space-y-3">
                                <div>
                                  <label class="text-sm font-medium text-muted-foreground block mb-1">
                                    Original Text
                                  </label>
                                  <div class="bg-gray-50 rounded p-3 text-sm font-mono whitespace-pre-wrap">
                                    {prompt.original_text}
                                  </div>
                                </div>

                                <Show when={prompt.transformed_text}>
                                  <div>
                                    <label class="text-sm font-medium text-muted-foreground block mb-1">
                                      Transformed Text
                                    </label>
                                    <div class="bg-blue-50 rounded p-3 text-sm font-mono whitespace-pre-wrap">
                                      {prompt.transformed_text}
                                    </div>
                                  </div>
                                </Show>
                              </div>
                            </div>
                          )
                        }}
                      </For>
                    </div>
                  </Show>
                </div>
              </div>
            )
          }}
        </Match>
      </Switch>
    </div>
  )
}

export const Route = createFileRoute('/projects/$id/')({
  component: ProjectDetail,
})
