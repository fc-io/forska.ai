import type {QueryClient} from '@tanstack/solid-query'
import {useQuery, useQueryClient} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {createSignal, For, Show, Suspense} from 'solid-js'

import {Button} from '../../../components/ui/button'
import {
  fetchActivePrompts,
  formatPromptTimestamp,
  getPromptPreview,
  isPromptPreviewTruncated,
  setPromptArchived,
} from './promptsUtils'

const updatePromptArchivedState = (
  queryClient: QueryClient,
  promptId: string,
  archived: boolean,
  setPendingPromptId: (value: string | null) => void,
  setErrorMessage: (value: string | null) => void,
) => {
  setErrorMessage(null)
  setPendingPromptId(promptId)
  return setPromptArchived(queryClient, promptId, archived).then(
    () => {
      setPendingPromptId(null)
    },
    (error) => {
      const message = error instanceof Error ? error.message : 'Failed to update prompt'
      setErrorMessage(message)
      setPendingPromptId(null)
    },
  )
}

export const PromptsPage = () => {
  const queryClient = useQueryClient()
  const promptsQuery = useQuery(() => {
    return {queryKey: ['prompts'], queryFn: fetchActivePrompts}
  })
  const [pendingPromptId, setPendingPromptId] = createSignal<string | null>(null)
  const [errorMessage, setErrorMessage] = createSignal<string | null>(null)
  const [expandedPromptById, setExpandedPromptById] = createSignal<Record<string, boolean>>({})

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto">
      <div class="flex justify-between items-center mb-6">
        <div class="flex items-center gap-4">
          <h1 class="text-2xl font-bold">Prompts</h1>
        </div>
        <div class="flex gap-2">
          <Button as={Link} to="/prompts/archived" variant="outline" size="sm">
            Archived prompts
          </Button>
        </div>
      </div>

      <Show when={errorMessage()}>
        <div class="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">{errorMessage()}</div>
      </Show>

      <Suspense fallback={<div class="text-center py-8">Loading prompts...</div>}>
        <Show when={promptsQuery.isError}>
          <div class="text-center py-8 text-red-600">
            Error loading prompts: {promptsQuery.error instanceof Error ? promptsQuery.error.message : 'Unknown error'}
          </div>
        </Show>

        <Show when={Array.isArray(promptsQuery.data) && promptsQuery.data.length === 0}>
          <div class="text-center py-12">
            <h2 class="text-xl font-semibold mb-4">No prompts</h2>
            <p class="text-muted-foreground mb-6">Prompts you create will appear here.</p>
            <Button as={Link} to="/projects/create">
              Create a project
            </Button>
          </div>
        </Show>

        <Show when={Array.isArray(promptsQuery.data) && (promptsQuery.data.length ?? 0) > 0}>
          <div class="space-y-3">
            <For each={promptsQuery.data ?? []}>
              {(prompt) => {
                return (
                  <div class="border rounded-lg p-4 bg-background">
                    <div class="flex justify-between items-start gap-4">
                      <div class="flex-1 min-w-0">
                        <div class="flex items-center gap-2 flex-wrap">
                          <span class="font-medium truncate">{prompt.promptHeading || 'Untitled prompt'}</span>
                          <Show when={prompt.type}>
                            <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                              {prompt.type}
                            </span>
                          </Show>
                        </div>
                        <div class="mt-1 text-xs text-muted-foreground">
                          Created {formatPromptTimestamp(prompt.createdAt)} • Owner {prompt.ownerId.slice(0, 8)}
                        </div>
                      </div>
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={pendingPromptId() === prompt.id}
                        onClick={() => {
                          if (!confirm('Archive this prompt? It will be hidden from prompt lists.')) {
                            return
                          }

                          return void updatePromptArchivedState(
                            queryClient,
                            prompt.id,
                            true,
                            setPendingPromptId,
                            setErrorMessage,
                          )
                        }}
                      >
                        {pendingPromptId() === prompt.id ? 'Archiving...' : 'Archive'}
                      </Button>
                    </div>
                    <div class="mt-3 bg-gray-50 rounded p-3 text-sm font-mono whitespace-pre-wrap">
                      <Show when={expandedPromptById()[prompt.id]} fallback={getPromptPreview(prompt.originalText)}>
                        {prompt.originalText}
                      </Show>
                    </div>
                    <Show when={isPromptPreviewTruncated(prompt.originalText)}>
                      <div class="mt-1 flex justify-end">
                        <Button
                          variant="link"
                          size="sm"
                          class="h-auto px-0 py-0 text-xs"
                          onClick={() => {
                            setExpandedPromptById((prev) => {
                              return {...prev, [prompt.id]: !prev[prompt.id]}
                            })
                          }}
                        >
                          {expandedPromptById()[prompt.id] ? 'Show less' : 'Show full'}
                        </Button>
                      </div>
                    </Show>
                  </div>
                )
              }}
            </For>
          </div>
        </Show>
      </Suspense>
    </div>
  )
}

export const Route = createFileRoute('/prompts/')({component: PromptsPage})
