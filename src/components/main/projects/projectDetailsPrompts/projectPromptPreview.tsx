import {useQuery} from '@tanstack/solid-query'
import {Match, Show, Switch} from 'solid-js'

import {
  fetchProjectPromptPreview,
  type ProjectPromptPreview as PromptPreview,
} from '../../../../services/projectsService.ts'

const unavailablePreviewMessages: Record<NonNullable<PromptPreview['reason']>, string> = {
  conversion_failed: 'Preview unavailable: full-text conversion failed for the first project article.',
  indexing: "Preview of the user prompt is unavailable: the project's review serving snapshot is still being built.",
  no_articles: 'Preview unavailable: this project has no articles yet.',
  no_fulltext:
    'Preview unavailable: the first project article has no full text to include for this project configuration.',
  ready:
    "Preview of the user prompt is unavailable: the project's review serving snapshot could not be read right now.",
  stale:
    "Preview of the user prompt is unavailable: the project's review serving snapshot is out of date and has not been rebuilt yet.",
  transient_failure: 'Preview unavailable: full-text preparation is still in progress for the first project article.',
  unavailable: "Preview of the user prompt is unavailable: the project's review serving snapshot is not ready yet.",
}

const getSystemPromptPreviewText = (systemPrompt: string) => {
  return `## System Prompt\n\n${systemPrompt}`
}

export const ProjectPromptPreview = (props: {projectId: string; promptId: string}) => {
  const previewQuery = useQuery(() => {
    return {
      queryKey: ['project', props.projectId, 'prompt-preview', props.promptId],
      queryFn: () => {
        return fetchProjectPromptPreview(props.projectId, props.promptId)
      },
      staleTime: 0,
    }
  })

  return (
    <Switch>
      <Match when={previewQuery.isLoading}>
        <div class="bg-gray-50 rounded p-3 text-sm text-muted-foreground">
          Loading preview from the first project article...
        </div>
      </Match>
      <Match when={previewQuery.isError}>
        <div class="bg-red-50 rounded p-3 text-sm text-red-700">
          {previewQuery.error instanceof Error ? previewQuery.error.message : 'Failed to load preview'}
        </div>
      </Match>
      <Match when={previewQuery.data?.status === 'unavailable'}>
        <div class="space-y-2">
          <div class="bg-amber-50 rounded p-3 text-sm text-amber-900">
            <div>{unavailablePreviewMessages[previewQuery.data?.reason ?? 'transient_failure']}</div>
            <div class="mt-2 text-xs text-amber-800">
              Preview article: {previewQuery.data?.articleTitle ?? previewQuery.data?.articleId ?? 'Unavailable'}
            </div>
          </div>
          <div class="text-xs text-muted-foreground">
            System prompt variant: {previewQuery.data?.systemPromptVariant}
          </div>
          <Show when={previewQuery.data?.systemPrompt}>
            {(systemPrompt) => {
              return (
                <div class="bg-gray-50 rounded p-3 text-sm font-mono whitespace-pre-wrap">
                  {getSystemPromptPreviewText(systemPrompt())}
                </div>
              )
            }}
          </Show>
        </div>
      </Match>
      <Match when={previewQuery.data}>
        <div class="space-y-2">
          <div class="text-xs text-muted-foreground">
            Preview article: {previewQuery.data?.articleTitle ?? previewQuery.data?.articleId ?? 'Unavailable'}
          </div>
          <div class="text-xs text-muted-foreground">
            System prompt variant: {previewQuery.data?.systemPromptVariant}
          </div>
          <div class="bg-gray-50 rounded p-3 text-sm font-mono whitespace-pre-wrap">
            {previewQuery.data?.previewText ?? ''}
          </div>
        </div>
      </Match>
    </Switch>
  )
}
