import {createFileRoute, Link, useNavigate} from '@tanstack/solid-router'
import {createSignal, For} from 'solid-js'
import {createStore} from 'solid-js/store'

import {Button} from '../../../components/ui/button'
import {apiClient} from '../../../services/apiClient'
import {authStore} from '../../../stores/authStore'

type PromptItem = {id: string; content: string}

const CreateProject = () => {
  const navigate = useNavigate()
  const [projectName, setProjectName] = createSignal('')
  const [description, setDescription] = createSignal('')
  const [prompts, setPrompts] = createStore<PromptItem[]>([
    {id: crypto.randomUUID(), content: ''},
  ])
  const [isLoading, setIsLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const addPromptInput = () => {
    setPrompts([...prompts, {id: crypto.randomUUID(), content: ''}])
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

  const updatePromptInput = (id: string, value: string) => {
    const idx = prompts.findIndex((p) => {
      return p.id === id
    })
    if (idx >= 0) {
      setPrompts(idx, 'content', value)
    }
  }

  const createProject = async (
    name: string,
    description: string,
    promptItems: PromptItem[],
  ) => {
    const user = authStore.user()
    if (!user) {
      throw new Error('User must be authenticated to create a project')
    }

    // Filter valid prompts
    const validPrompts = promptItems
      .filter((prompt) => {
        return prompt.content.trim()
      })
      .map((prompt) => {
        return prompt.content.trim()
      })

    const response = await apiClient.api.projects.post({
      name,
      description: description.trim() || undefined,
      ownerId: user.id,
      prompts: validPrompts,
    })

    if (response.error) {
      throw new Error('Failed to create project')
    }

    if (response.data?.error) {
      throw new Error(response.data.error)
    }

    if (!response.data?.data) {
      throw new Error('Failed to create project: No data returned')
    }

    return response.data.data
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
      const errorMessage =
        err instanceof Error ? err.message : 'An unexpected error occurred'
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
        {error() && (
          <div class="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">
            {error()}
          </div>
        )}
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
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addPromptInput}
              >
                + Add Prompt
              </Button>
            </div>
            <div class="space-y-3">
              <For each={prompts} fallback={<div>No prompts</div>}>
                {(promptItem, index) => {
                  return (
                    <div class="flex gap-2">
                      <textarea
                        value={promptItem.content}
                        onInput={(e) => {
                          return updatePromptInput(
                            promptItem.id,
                            e.currentTarget.value,
                          )
                        }}
                        placeholder={`Enter prompt ${index() + 1} content...`}
                        rows="4"
                        class="flex-1 px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent resize-none"
                      />
                      {prompts.length > 1 && (
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
                      )}
                    </div>
                  )
                }}
              </For>
            </div>
          </div>

          <div class="flex gap-3 pt-4">
            <Button
              type="submit"
              disabled={!projectName().trim() || isLoading()}
            >
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

export const Route = createFileRoute('/projects/create')({
  component: CreateProject,
})
