import {useQuery} from '@tanstack/solid-query'
import {Link} from '@tanstack/solid-router'
import {createMemo, Show} from 'solid-js'

import {apiClient} from '../../../services/apiClient.ts'
import {handleApiResponse} from '../../../services/utils/handleApiResponse.ts'

type ReviewsWarningsData = {projectId: string; enabledPromptCount: number; scope: {hasAnyArticlesInScope: boolean}}

export const ReviewsProjectWarnings = (props: {projectId: string}) => {
  const query = useQuery(() => {
    return {
      queryKey: ['project-reviews-warnings', props.projectId],
      queryFn: async () => {
        const response = await apiClient.api.projectsreviewswarnings.post({projectId: props.projectId})
        const data = handleApiResponse(response, 'Failed to load project warnings')
        return data.data as unknown as ReviewsWarningsData
      },
      refetchOnWindowFocus: false,
      staleTime: 1000 * 60,
    }
  })

  const healthData = () => {
    return query.isSuccess ? (query.data ?? null) : null
  }

  const noEnabledPrompts = createMemo(() => {
    return (healthData()?.enabledPromptCount ?? 0) === 0
  })

  const noArticlesInProject = createMemo(() => {
    const data = healthData()
    if (!data) return false

    const hasEnabledPrompts = data.enabledPromptCount > 0
    const hasAnyArticlesInScope = data.scope.hasAnyArticlesInScope
    return hasEnabledPrompts && !hasAnyArticlesInScope
  })

  return (
    <Show when={healthData()}>
      <div class="space-y-3">
        <Show when={noEnabledPrompts()}>
          <div class="p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
            <div class="flex items-start justify-between gap-3">
              <div>
                <p class="font-medium text-yellow-800">No enabled prompts</p>
                <p class="text-sm text-yellow-700 mt-1">
                  This project has 0 enabled prompts, so there is nothing to assess.
                </p>
              </div>
              <Link
                to="/projects/$id/edit"
                params={{id: props.projectId} as never}
                class="text-sm text-yellow-800 underline whitespace-nowrap"
              >
                Edit project
              </Link>
            </div>
          </div>
        </Show>

        <Show when={noArticlesInProject()}>
          <div class="p-4 bg-slate-50 border border-slate-200 rounded-lg">
            <p class="font-medium text-slate-800">No articles in project</p>
            <p class="text-sm text-slate-700 mt-1">
              This project has no scoped articles (no individually imported articles, and no import routes with any
              matching articles).
            </p>
          </div>
        </Show>
      </div>
    </Show>
  )
}
