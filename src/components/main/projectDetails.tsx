import {Link, useNavigate} from '@tanstack/solid-router'
import {format} from 'date-fns'
import {createResource, createSignal, For, Match, Show, Switch} from 'solid-js'

import {
  deleteProject,
  fetchProjectWithPrompts,
} from '../../services/projectsService'
import {Button} from '../ui/button'

export const ProjectDetails = (props: {projectId: string}) => {
  const navigate = useNavigate()
  const [deletingProject, setDeletingProject] = createSignal(false)
  const [projectData] = createResource(() => {
    return fetchProjectWithPrompts(props.projectId)
  })

  const formatDate = (dateString: string | null) => {
    if (!dateString) return 'Never'
    return format(dateString, 'PPpp')
  }

  const handleDeleteProject = async () => {
    const projectName = projectData()?.project.name
    if (
      !confirm(
        `Are you sure you want to delete the project "${projectName}"? This action cannot be undone.`,
      )
    ) {
      return
    }

    setDeletingProject(true)
    try {
      await deleteProject(props.projectId)
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
    <>
      <div class="flex justify-between items-center mb-6">
        <div class="flex items-center gap-4">
          <Button as={Link} href="/projects" variant="outline" size="sm">
            ← Back to Projects
          </Button>
          <h1 class="text-3xl font-bold">Project Details</h1>
        </div>
        <Show when={projectData.state === 'ready'}>
          <div class="flex gap-2">
            <Button as={Link} href={`/projects/${props.projectId}/edit`}>
              Edit Project
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteProject}
              disabled={deletingProject()}
            >
              {deletingProject() ? 'Deleting...' : 'Delete Project'}
            </Button>
          </div>
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
                                  <Show when={prompt.promptHeading}>
                                    <span class="font-medium">
                                      {prompt.promptHeading}
                                    </span>
                                  </Show>
                                  <Show when={prompt.type}>
                                    <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                                      {prompt.type}
                                    </span>
                                  </Show>
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
    </>
  )
}
