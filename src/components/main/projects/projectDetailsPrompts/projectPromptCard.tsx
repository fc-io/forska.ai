import {createSignal, Show} from 'solid-js'

import {Button} from '../../../ui/button'
import {ProjectPromptPreview} from './projectPromptPreview.tsx'

export type ProjectDetailsPrompt = {
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
  linkedToProject?: boolean
  provider?: string | null
  modelName?: string | null
  contentHash?: string | null
}

export const ProjectPromptCard = (props: {
  formatDate: (dateString: string | null) => string
  projectId?: string
  prompt: ProjectDetailsPrompt
}) => {
  const [previewMode, setPreviewMode] = createSignal(false)
  const canPreview = () => {
    return Boolean(
      props.projectId && props.prompt.id && props.prompt.linkedToProject === true && props.prompt.enabled !== false,
    )
  }

  return (
    <div class="border rounded-lg p-4 bg-background" classList={{'opacity-40': props.prompt.enabled === false}}>
      <div class="flex justify-between items-start mb-3">
        <div class="flex items-center gap-2">
          <span class="inline-flex items-center justify-center w-6 h-6 rounded-full bg-primary text-primary-foreground text-xs font-medium">
            {props.prompt.order}
          </span>
          <Show when={props.prompt.promptHeading}>
            <span class="font-medium">{props.prompt.promptHeading}</span>
          </Show>
          <Show when={props.prompt.type}>
            <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
              {props.prompt.type}
            </span>
          </Show>
          <Show when={props.prompt.linkedToProject !== true}>
            <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
              Imported
            </span>
          </Show>
          <Show when={props.prompt.linkedToProject !== true}>
            <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
              {props.prompt.provider || 'no provider set'}
            </span>
            <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
              {props.prompt.modelName || 'no model set'}
            </span>
          </Show>
          <Show when={props.prompt.enabled !== undefined}>
            <span
              class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium"
              classList={{
                'bg-green-100 text-green-800': props.prompt.enabled,
                'bg-gray-100 text-gray-800': !props.prompt.enabled,
              }}
            >
              {props.prompt.enabled ? 'Enabled' : 'Disabled'}
            </span>
          </Show>
          <Show when={props.prompt.id}>
            <span class="inline-flex items-center px-2 py-1 rounded-full text-[11px] font-medium bg-gray-50 text-gray-600">
              Prompt ID: {(props.prompt.id || '').slice(0, 8)}
            </span>
          </Show>
          <Show when={props.prompt.contentHash}>
            <span class="inline-flex items-center px-2 py-1 rounded-full text-[11px] font-medium bg-gray-50 text-gray-600">
              Prompt Hash: {(props.prompt.contentHash || '').slice(0, 8)}
            </span>
          </Show>
          <span class="text-sm text-muted-foreground">Created {props.formatDate(props.prompt.created_at)}</span>
          <Show when={props.prompt.archived}>
            <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
              Archived
            </span>
          </Show>
        </div>
      </div>

      <div class="space-y-3">
        <div>
          <div class="flex items-center justify-between gap-2 mb-1">
            <label class="text-sm font-medium text-muted-foreground block">
              {previewMode() && canPreview() ? 'Preview Prompt' : 'Original Text'}
            </label>
            <Show when={canPreview()}>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setPreviewMode((current) => {
                    return !current
                  })
                }}
              >
                {previewMode() ? 'Show Original Text' : 'Preview Prompt'}
              </Button>
            </Show>
          </div>
          <Show
            when={previewMode() && canPreview() && props.projectId && props.prompt.id}
            fallback={
              <div class="bg-gray-50 rounded p-3 text-sm font-mono whitespace-pre-wrap">
                {props.prompt.original_text}
              </div>
            }
          >
            <ProjectPromptPreview projectId={props.projectId as string} promptId={props.prompt.id as string} />
          </Show>
        </div>

        <Show when={props.prompt.transformed_text}>
          <div>
            <label class="text-sm font-medium text-muted-foreground block mb-1">Transformed Text</label>
            <div class="bg-blue-50 rounded p-3 text-sm font-mono whitespace-pre-wrap">
              {props.prompt.transformed_text}
            </div>
          </div>
        </Show>
      </div>
    </div>
  )
}
