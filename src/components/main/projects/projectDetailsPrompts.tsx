import {createMemo, For, Show} from 'solid-js'

import {type ProjectDetailsPrompt, ProjectPromptCard} from './projectDetailsPrompts/projectPromptCard.tsx'

type ProjectDetailsPromptsProps = {
  prompts: ProjectDetailsPrompt[]
  projectId?: string
  formatDate: (dateString: string | null) => string
}

export const ProjectDetailsPrompts = (props: ProjectDetailsPromptsProps) => {
  const owned = createMemo(() => {
    return props.prompts.filter((p) => {
      return p.linkedToProject === true
    })
  })
  const linked = createMemo(() => {
    return props.prompts.filter((p) => {
      return p.linkedToProject !== true
    })
  })

  return (
    <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-8">
      <Show when={props.prompts.length === 0}>
        <div class="text-center py-8 text-muted-foreground">
          <p class="text-lg mb-2">No prompts found for this project</p>
          <p class="text-sm">Prompts will appear here once they are created.</p>
        </div>
      </Show>

      <Show when={owned().length > 0}>
        <div class="space-y-4">
          <h3 class="text-lg font-semibold">Project Prompts ({owned().length})</h3>
          <For each={owned()}>
            {(p) => {
              return <ProjectPromptCard formatDate={props.formatDate} projectId={props.projectId} prompt={p} />
            }}
          </For>
        </div>
      </Show>

      <Show when={linked().length > 0}>
        <div class="space-y-4 mt-6">
          <h3 class="text-lg font-semibold">Imported prompts on articles from other projects ({linked().length})</h3>
          <For each={linked()}>
            {(p) => {
              return <ProjectPromptCard formatDate={props.formatDate} projectId={props.projectId} prompt={p} />
            }}
          </For>
        </div>
      </Show>
    </div>
  )
}
