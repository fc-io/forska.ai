import {useQuery, useQueryClient} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import type {JSX} from 'solid-js'
import {createMemo, createSignal, For, Show, Suspense} from 'solid-js'

import {Button} from '../../../../components/ui/button'
import {apiClient} from '../../../../services/apiClient'
import {fetchProjectWithPrompts} from '../../../../services/projectsService'

type PromptView = {
  id: string
  originalText: string
  promptHeading: string | null
  type: string | null
  order: number | null
  archived: boolean
  enabled: boolean
  originProjectId: string | null
  createdAt: string | Date | null
}

const mapPromptView = (prompt: any): PromptView => {
  return {
    id: String(prompt.id),
    originalText: String(prompt.originalText ?? ''),
    promptHeading: typeof prompt.promptHeading === 'string' ? prompt.promptHeading : null,
    type: typeof prompt.type === 'string' ? prompt.type : null,
    order: typeof prompt.order === 'number' ? prompt.order : null,
    archived: Boolean(prompt.archived),
    enabled: typeof prompt.enabled === 'boolean' ? prompt.enabled : Boolean(prompt.enabled ?? false),
    originProjectId: typeof prompt.originProjectId === 'string' ? prompt.originProjectId : null,
    createdAt: (prompt.createdAt as any) ?? null,
  }
}

const byOrder = (a: PromptView, b: PromptView) => {
  const oa = typeof a.order === 'number' ? a.order : Number.POSITIVE_INFINITY
  const ob = typeof b.order === 'number' ? b.order : Number.POSITIVE_INFINITY
  return oa - ob
}

const formatCreatedAt = (value: string | Date | null) => {
  if (!value) return '—'
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString()
}

const PromptsPage = (): JSX.Element => {
  const params = Route.useParams()
  const projectId = (params() as {id: string}).id
  const queryClient = useQueryClient()
  const [busyPromptId, setBusyPromptId] = createSignal<string | null>(null)
  const [errorMessage, setErrorMessage] = createSignal<string | null>(null)

  const projectData = useQuery(() => {
    return {
      queryKey: ['project', projectId, 'with-prompts'],
      queryFn: () => {
        return fetchProjectWithPrompts(projectId)
      },
    }
  })

  const prompts = createMemo(() => {
    const raw = (projectData.data as any)?.prompts
    const list = Array.isArray(raw)
      ? raw.map((p) => {
          return mapPromptView(p)
        })
      : []
    return list.slice().sort(byOrder)
  })

  const activePrompts = createMemo(() => {
    return prompts().filter((p) => {
      return !p.archived
    })
  })

  const archivedPrompts = createMemo(() => {
    return prompts().filter((p) => {
      return p.archived
    })
  })

  const setArchived = (promptId: string, archived: boolean) => {
    setBusyPromptId(promptId)
    setErrorMessage(null)
    return apiClient.api.projects({id: projectId}).prompts({promptId}).archive.patch({archived}).then(
      (response) => {
        setBusyPromptId(null)
        if (response.error || !response.data?.data) {
          setErrorMessage('Failed to update prompt archive state')
          return
        }
        void queryClient.invalidateQueries({queryKey: ['project', projectId, 'with-prompts']})
      },
      () => {
        setBusyPromptId(null)
        setErrorMessage('Failed to update prompt archive state')
      },
    )
  }

  const PromptRow = (prompt: PromptView): JSX.Element => {
    const isBusy = () => busyPromptId() === prompt.id
    const isOwned = () => prompt.originProjectId === projectId

    return (
      <div class="border rounded-lg p-4 bg-background">
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <Show when={typeof prompt.order === 'number'}>
                <span class="inline-flex items-center justify-center w-6 h-6 rounded-full bg-primary text-primary-foreground text-xs font-medium">
                  {prompt.order}
                </span>
              </Show>
              <Show when={prompt.promptHeading}>
                <span class="font-medium truncate">{prompt.promptHeading}</span>
              </Show>
              <Show when={prompt.type}>
                <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                  {prompt.type}
                </span>
              </Show>
              <Show when={!isOwned()}>
                <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
                  Imported
                </span>
              </Show>
              <span
                class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium"
                classList={{
                  'bg-green-100 text-green-800': prompt.enabled,
                  'bg-gray-100 text-gray-800': !prompt.enabled,
                }}
              >
                {prompt.enabled ? 'Enabled' : 'Disabled'}
              </span>
              <Show when={prompt.archived}>
                <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
                  Archived
                </span>
              </Show>
              <span class="inline-flex items-center px-2 py-1 rounded-full text-[11px] font-medium bg-gray-50 text-gray-600 font-mono">
                {prompt.id.slice(0, 8)}
              </span>
              <span class="text-sm text-muted-foreground">Created {formatCreatedAt(prompt.createdAt)}</span>
            </div>
            <div class="mt-3 bg-gray-50 rounded p-3 text-sm font-mono whitespace-pre-wrap">{prompt.originalText}</div>
          </div>
          <div class="flex shrink-0 flex-col items-end gap-2">
            <Button
              variant={prompt.archived ? 'outline' : 'default'}
              size="sm"
              disabled={isBusy()}
              onClick={() => {
                return void setArchived(prompt.id, !prompt.archived)
              }}
            >
              {isBusy() ? 'Saving...' : prompt.archived ? 'Unarchive' : 'Archive'}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto">
      <div class="flex items-center gap-4 mb-6">
        <Button as={Link} to="/projects/$id/" params={{id: projectId}} variant="outline" size="sm">
          ← Back to Project Details
        </Button>
        <h1 class="text-2xl font-bold">Prompts</h1>
        <span class="text-sm text-gray-500">Project: {projectId}</span>
      </div>

      <Suspense fallback={<div class="text-center py-8">Loading prompts...</div>}>
        <Show
          when={!projectData.isError}
          fallback={
            <div class="text-center py-8 text-red-600">
              Error loading prompts: {projectData.error instanceof Error ? projectData.error.message : 'Unknown error'}
            </div>
          }
        >
          <div class="space-y-6">
            <Show when={errorMessage()}>
              <div class="bg-red-50 border border-red-200 rounded-md p-3 text-red-700 text-sm">{errorMessage()}</div>
            </Show>
            <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
              <h2 class="text-lg font-semibold mb-4">Active ({activePrompts().length})</h2>
              <Show when={activePrompts().length > 0} fallback={<div class="text-sm text-muted-foreground">—</div>}>
                <div class="space-y-3">
                  <For each={activePrompts()}>
                    {(prompt) => {
                      return PromptRow(prompt)
                    }}
                  </For>
                </div>
              </Show>
            </div>

            <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
              <h2 class="text-lg font-semibold mb-4">Archived ({archivedPrompts().length})</h2>
              <Show
                when={archivedPrompts().length > 0}
                fallback={<div class="text-sm text-muted-foreground">—</div>}
              >
                <div class="space-y-3">
                  <For each={archivedPrompts()}>
                    {(prompt) => {
                      return PromptRow(prompt)
                    }}
                  </For>
                </div>
              </Show>
            </div>
          </div>
        </Show>
      </Suspense>
    </div>
  )
}

export const Route = createFileRoute('/projects/$id/prompts')({component: PromptsPage})
