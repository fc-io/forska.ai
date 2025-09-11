import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link, useNavigate} from '@tanstack/solid-router'
import {createSignal, For, Show} from 'solid-js'
import {createStore} from 'solid-js/store'

import {Button} from '../../../components/ui/button'
import {apiClient} from '../../../services/apiClient'
import {fetchSession} from '../../../services/fetchSession'
import {handleApiResponse} from '../../../services/utils/handleApiResponse'

type PromptItem = {id: string; content: string; promptHeading: string; type: string}

const CreateProject = () => {
  const sessionQuery = useQuery(() => {
    return {
      queryKey: ['session'],
      queryFn: fetchSession,
      staleTime: 1000 * 60 * 5, // Consider data fresh for 5 minutes
    }
  })
  const navigate = useNavigate()
  const [projectName, setProjectName] = createSignal('')
  const [description, setDescription] = createSignal('')
  const [prompts, setPrompts] = createStore<PromptItem[]>([
    {id: crypto.randomUUID(), content: '', promptHeading: '', type: ''},
  ])
  const [isLoading, setIsLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const addPromptInput = () => {
    setPrompts([...prompts, {id: crypto.randomUUID(), content: '', promptHeading: '', type: ''}])
  }

  const removePromptInput = (id: string) => {
    if (prompts.length > 1) {
      setPrompts(
        prompts.filter((prompt) => {
          return prompt.id !== id
        }),
      )
    }
  }

  const updatePromptInput = (id: string, field: 'content' | 'promptHeading' | 'type', value: string) => {
    const idx = prompts.findIndex((p) => {
      return p.id === id
    })
    if (idx >= 0) {
      setPrompts(idx, field, value)
    }
  }

  const createProject = async (name: string, description: string, promptItems: PromptItem[]) => {
    // Filter valid prompts
    const validPrompts = promptItems
      .filter((prompt) => {
        return prompt.content.trim()
      })
      .map((prompt, index) => {
        return {
          content: prompt.content.trim(),
          promptHeading: prompt.promptHeading.trim() || undefined,
          type: prompt.type.trim() || undefined,
          order: index,
        }
      })

    if (!sessionQuery.data?.user.id) {
      throw new Error('User must be authenticated to create a project')
    }

    const response = await apiClient.api.projects.post({
      name,
      description: description.trim() || undefined,
      ownerId: sessionQuery.data.user.id,
      prompts: validPrompts,
    })

    const result = handleApiResponse(response, 'Failed to create project')
    if (!result.data) {
      throw new Error('Failed to create project: No data returned')
    }
    return result.data
  }

  const handleSubmit = async (e: Event) => {
    e.preventDefault()

    // Clear any previous errors
    setError(null)
    setIsLoading(true)

    try {
      await createProject(projectName(), description(), prompts)
      // Navigate back to projects page on success
      void navigate({to: '/projects'})
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unexpected error occurred'
      setError(errorMessage)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div class="p-6 max-w-4xl mx-auto">
      <div class="flex items-center gap-4 mb-6">
        <Button as={Link} href="/projects" variant="outline" size="sm">
          ← Back to Projects
        </Button>
        <h1 class="text-3xl font-bold">Create New Project</h1>
      </div>

      <div class="bg-card border rounded-lg p-6">
        <Show when={error()}>
          <div class="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">{error()}</div>
        </Show>
        <form
          onSubmit={(e) => {
            return void handleSubmit(e)
          }}
          class="space-y-6"
        >
          <div>
            <label for="project-name" class="block text-sm font-medium mb-2">
              Project Name *
            </label>
            <input
              id="project-name"
              type="text"
              value={projectName()}
              onInput={(e) => {
                return setProjectName(e.currentTarget.value)
              }}
              placeholder="Enter project name"
              class="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
              required
            />
          </div>

          <div>
            <label for="description" class="block text-sm font-medium mb-2">
              Description
            </label>
            <textarea
              id="description"
              value={description()}
              onInput={(e) => {
                return setDescription(e.currentTarget.value)
              }}
              placeholder="Describe your project..."
              rows="4"
              class="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent resize-none"
            />
          </div>

          <div>
            <div class="flex items-center justify-between mb-2">
              <label class="block text-sm font-medium">Prompts</label>
              <Button type="button" variant="outline" size="sm" onClick={addPromptInput}>
                + Add Prompt
              </Button>
            </div>
            <div class="space-y-3">
              <For each={prompts} fallback={<div>No prompts</div>}>
                {(promptItem, index) => {
                  return (
                    <div class="flex gap-2">
                      <div class="flex-1 space-y-2">
                        <input
                          type="text"
                          value={promptItem.promptHeading}
                          onInput={(e) => {
                            return updatePromptInput(promptItem.id, 'promptHeading', e.currentTarget.value)
                          }}
                          placeholder={`Prompt ${index() + 1} heading (optional)...`}
                          class="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
                        />
                        <input
                          type="text"
                          value={promptItem.type}
                          onInput={(e) => {
                            return updatePromptInput(promptItem.id, 'type', e.currentTarget.value)
                          }}
                          placeholder={`Prompt ${index() + 1} type (optional)...`}
                          class="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
                        />
                        <textarea
                          value={promptItem.content}
                          onInput={(e) => {
                            return updatePromptInput(promptItem.id, 'content', e.currentTarget.value)
                          }}
                          placeholder={`Enter prompt ${index() + 1} content...`}
                          rows="4"
                          class="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent resize-none"
                        />
                      </div>
                      <Show when={prompts.length > 1}>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            return removePromptInput(promptItem.id)
                          }}
                          class="self-start mt-1"
                        >
                          ×
                        </Button>
                      </Show>
                    </div>
                  )
                }}
              </For>
            </div>
          </div>

          <div class="flex gap-3 pt-4">
            <Button type="submit" disabled={!projectName().trim() || isLoading()}>
              {isLoading() ? 'Creating...' : 'Create Project'}
            </Button>
            <Button as={Link} href="/projects" variant="outline">
              Cancel
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/projects/create')({component: CreateProject})
