import {For, Show} from 'solid-js'

type Prompt = {
  id?: string
  order: number
  promptHeading?: string
  type?: string
  created_at: string
  archived?: boolean
  original_text: string
  transformed_text?: string
  enabled?: boolean
  originProjectId?: string | null
  provider?: string | null
  modelName?: string | null
  contentHash?: string | null
}

type ProjectDetailsPromptsProps = {
  prompts: Prompt[]
  projectId?: string
  formatDate: (dateString: string | null) => string
}

export const ProjectDetailsPrompts = (props: ProjectDetailsPromptsProps) => {
  const shouldShowPrompt = (prompt: Prompt) => {
    if (!prompt.archived) {
      return true
    }
    if (prompt.enabled) {
      return true
    }
    if (props.projectId && prompt.originProjectId === props.projectId) {
      return true
    }
    return false
  }

  const visiblePrompts = props.prompts.filter(shouldShowPrompt)

  const owned = visiblePrompts.filter((p) => {
    return props.projectId && p.originProjectId === props.projectId
  })
  const linked = visiblePrompts.filter((p) => {
    return !props.projectId || p.originProjectId !== props.projectId
  })

  const PromptCard = (prompt: Prompt) => {
    return (
      <div class="border rounded-lg p-4 bg-background" classList={{'opacity-40': prompt.enabled === false}}>
        <div class="flex justify-between items-start mb-3">
          <div class="flex items-center gap-2">
            <span class="inline-flex items-center justify-center w-6 h-6 rounded-full bg-primary text-primary-foreground text-xs font-medium">
              {prompt.order}
            </span>
            <Show when={prompt.promptHeading}>
              <span class="font-medium">{prompt.promptHeading}</span>
            </Show>
            <Show when={prompt.type}>
              <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                {prompt.type}
              </span>
            </Show>
            <Show when={props.projectId ? prompt.originProjectId !== props.projectId : prompt.originProjectId === null}>
              <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
                Imported
              </span>
            </Show>
            <Show when={props.projectId ? prompt.originProjectId !== props.projectId : prompt.originProjectId === null}>
              <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
                {prompt.provider || 'no provider set'}
              </span>
              <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
                {prompt.modelName || 'no model set'}
              </span>
            </Show>
            <Show when={prompt.enabled !== undefined}>
              <span
                class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium"
                classList={{
                  'bg-green-100 text-green-800': prompt.enabled,
                  'bg-gray-100 text-gray-800': !prompt.enabled,
                }}
              >
                {prompt.enabled ? 'Enabled' : 'Disabled'}
              </span>
            </Show>
            <Show when={prompt.id}>
              <span class="inline-flex items-center px-2 py-1 rounded-full text-[11px] font-medium bg-gray-50 text-gray-600">
                Prompt ID: {(prompt.id || '').slice(0, 8)}
              </span>
            </Show>
            <Show when={prompt.contentHash}>
              <span class="inline-flex items-center px-2 py-1 rounded-full text-[11px] font-medium bg-gray-50 text-gray-600">
                Prompt Hash: {(prompt.contentHash || '').slice(0, 8)}
              </span>
            </Show>
            <span class="text-sm text-muted-foreground">Created {props.formatDate(prompt.created_at)}</span>
            <Show when={prompt.archived}>
              <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
                Archived
              </span>
            </Show>
          </div>
        </div>

        <div class="space-y-3">
          <div>
            <label class="text-sm font-medium text-muted-foreground block mb-1">Original Text</label>
            <div class="bg-gray-50 rounded p-3 text-sm font-mono whitespace-pre-wrap">{prompt.original_text}</div>
          </div>

          <Show when={prompt.transformed_text}>
            <div>
              <label class="text-sm font-medium text-muted-foreground block mb-1">Transformed Text</label>
              <div class="bg-blue-50 rounded p-3 text-sm font-mono whitespace-pre-wrap">{prompt.transformed_text}</div>
            </div>
          </Show>
        </div>
      </div>
    )
  }

  return (
    <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-8">
      <Show when={visiblePrompts.length === 0}>
        <div class="text-center py-8 text-muted-foreground">
          <p class="text-lg mb-2">No prompts found for this project</p>
          <p class="text-sm">Prompts will appear here once they are created.</p>
        </div>
      </Show>

      <Show when={owned.length > 0}>
        <div class="space-y-4">
          <h3 class="text-lg font-semibold">Project Prompts ({owned.length})</h3>
          <For each={owned}>
            {(p) => {
              return PromptCard(p)
            }}
          </For>
        </div>
      </Show>

      <Show when={linked.length > 0}>
        <div class="space-y-4 mt-6">
          <h3 class="text-lg font-semibold">Imported prompts on articles from other projects ({linked.length})</h3>
          <For each={linked}>
            {(p) => {
              return PromptCard(p)
            }}
          </For>
        </div>
      </Show>
    </div>
  )
}
