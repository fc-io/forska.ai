import {useQuery} from '@tanstack/solid-query'
import {Match, Switch} from 'solid-js'

import {fetchProjectPromptPreview} from '../../../../services/projectsService.ts'

const getUnavailablePreviewMessage = (
  reason: 'conversion_failed' | 'no_articles' | 'no_fulltext' | 'transient_failure' | null,
) => {
  return reason === 'no_articles'
    ? 'Preview unavailable: this project has no articles yet.'
    : reason === 'no_fulltext'
      ? 'Preview unavailable: the first project article has no full text to include for this project configuration.'
      : reason === 'conversion_failed'
        ? 'Preview unavailable: full-text conversion failed for the first project article.'
        : 'Preview unavailable: full-text preparation is still in progress for the first project article.'
}

export const ProjectPromptPreview = (props: {projectId: string; promptId: string}) => {
  const previewQuery = useQuery(() => {
    return {
      queryKey: ['project', props.projectId, 'prompt-preview', props.promptId],
      queryFn: () => {
        return fetchProjectPromptPreview(props.projectId, props.promptId)
      },
      staleTime: 60 * 1000,
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
        <div class="bg-amber-50 rounded p-3 text-sm text-amber-900">
          <div>{getUnavailablePreviewMessage(previewQuery.data?.reason ?? 'transient_failure')}</div>
          <div class="mt-2 text-xs text-amber-800">
            Preview article: {previewQuery.data?.articleTitle ?? previewQuery.data?.articleId ?? 'Unavailable'}
          </div>
        </div>
      </Match>
      <Match when={previewQuery.data}>
        <div class="space-y-2">
          <div class="text-xs text-muted-foreground">
            Preview article: {previewQuery.data?.articleTitle ?? previewQuery.data?.articleId ?? 'Unavailable'}
          </div>
          <div class="bg-gray-50 rounded p-3 text-sm font-mono whitespace-pre-wrap">
            {previewQuery.data?.previewText ?? ''}
          </div>
        </div>
      </Match>
    </Switch>
  )
}
