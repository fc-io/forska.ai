import {For, Show} from 'solid-js'

type Prompt = {
  order: number
  promptHeading?: string
  type?: string
  created_at: string
  archived?: boolean
  original_text: string
  transformed_text?: string
}

type ProjectDetailsPromptsProps = {prompts: Prompt[]; formatDate: (dateString: string | null) => string}

export const ProjectDetailsPrompts = (props: ProjectDetailsPromptsProps) => {
  return (
    <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-8">
      <div class="flex justify-between items-center mb-4">
        <h2 class="text-2xl font-semibold">Prompts ({props.prompts.length})</h2>
      </div>

      <Show when={props.prompts.length === 0}>
        <div class="text-center py-8 text-muted-foreground">
          <p class="text-lg mb-2">No prompts found for this project</p>
          <p class="text-sm">Prompts will appear here once they are created.</p>
        </div>
      </Show>

      <Show when={props.prompts.length > 0}>
        <div class="space-y-4">
          <For each={props.prompts}>
            {(prompt) => {
              return (
                <div class="border rounded-lg p-4 bg-background">
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
                      <div class="bg-gray-50 rounded p-3 text-sm font-mono whitespace-pre-wrap">
                        {prompt.original_text}
                      </div>
                    </div>

                    <Show when={prompt.transformed_text}>
                      <div>
                        <label class="text-sm font-medium text-muted-foreground block mb-1">Transformed Text</label>
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
  )
}
