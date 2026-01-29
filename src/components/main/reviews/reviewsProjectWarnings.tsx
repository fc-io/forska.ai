import {useQuery} from '@tanstack/solid-query'
import {Link} from '@tanstack/solid-router'
import {createMemo, Show} from 'solid-js'

import {apiClient} from '../../../services/apiClient.ts'
import {handleApiResponse} from '../../../services/utils/handleApiResponse.ts'

type ReviewsHealthData = {
  projectId: string
  enabledPromptCount: number
  scope: {
    curatedArticleCount: number
    importRoutes: string[]
    importRouteArticlesCount: number
    postgresArticlesInScope: number
  }
  clickhouse:
    | {ok: true; routeArticlesInScope: number; curatedSampleSize: number; curatedSampleFound: number}
    | {ok: false; error: string; routeArticlesInScope: number; curatedSampleSize: number; curatedSampleFound: number}
}

export const ReviewsProjectWarnings = (props: {projectId: string; showClickhouse?: boolean}) => {
  const query = useQuery(() => {
    return {
      queryKey: ['project-reviews-health', props.projectId],
      queryFn: async () => {
        const response = await apiClient.api.projectsreviewshealth.post({projectId: props.projectId})
        const data = handleApiResponse(response, 'Failed to check project health')
        return data.data as ReviewsHealthData
      },
      refetchOnWindowFocus: false,
      staleTime: 1000 * 60,
    }
  })

  const noEnabledPrompts = createMemo(() => {
    return (query.data?.enabledPromptCount ?? 0) === 0
  })

  const noArticlesInProject = createMemo(() => {
    if (!query.data) {
      return false
    }

    const hasEnabledPrompts = query.data.enabledPromptCount > 0
    const hasAnyArticlesInScope = query.data.scope.postgresArticlesInScope > 0
    return hasEnabledPrompts && !hasAnyArticlesInScope
  })

  const clickhouseUnavailable = createMemo(() => {
    if (!props.showClickhouse) {
      return false
    }
    return query.data ? query.data.clickhouse.ok === false : false
  })

  const clickhouseMissingArticles = createMemo(() => {
    if (!props.showClickhouse) {
      return false
    }
    if (!query.data || query.data.clickhouse.ok === false) {
      return false
    }

    const hasEnabledPrompts = query.data.enabledPromptCount > 0
    const hasAnyArticlesInScope = query.data.scope.postgresArticlesInScope > 0
    if (!hasEnabledPrompts || !hasAnyArticlesInScope) {
      return false
    }

    const routeMissing =
      query.data.scope.importRouteArticlesCount > 0
      && query.data.clickhouse.routeArticlesInScope < query.data.scope.importRouteArticlesCount

    const curatedSampleMissing =
      query.data.scope.curatedArticleCount > 0
      && query.data.clickhouse.curatedSampleSize > 0
      && query.data.clickhouse.curatedSampleFound === 0

    return routeMissing || curatedSampleMissing
  })

  return (
    <Show when={query.data}>
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

        <Show when={clickhouseUnavailable()}>
          <div class="p-4 bg-red-50 border border-red-200 rounded-lg">
            <p class="font-medium text-red-800">ClickHouse unavailable</p>
            <p class="text-sm text-red-700 mt-1">The reviews lists use ClickHouse. It failed to respond.</p>
            <p class="text-xs text-red-700 mt-2 font-mono break-all">
              {(query.data?.clickhouse as {error?: string}).error}
            </p>
          </div>
        </Show>

        <Show when={clickhouseMissingArticles()}>
          <div class="p-4 bg-red-50 border border-red-200 rounded-lg">
            <p class="font-medium text-red-800">ClickHouse missing articles</p>
            <p class="text-sm text-red-700 mt-1">
              Articles exist in Postgres for this project, but ClickHouse appears to be missing them, so “Assessed by
              LLM” and “Unassessed” can show empty.
            </p>
            <div class="text-xs text-red-700 mt-2">
              <span class="font-mono">PG scoped:</span> {query.data?.scope.postgresArticlesInScope.toLocaleString()}{' '}
              <span class="font-mono">CH routes:</span> {query.data?.clickhouse.routeArticlesInScope.toLocaleString()}{' '}
              <span class="font-mono">CH curated sample:</span> {query.data?.clickhouse.curatedSampleFound}/
              {query.data?.clickhouse.curatedSampleSize}
            </div>
          </div>
        </Show>
      </div>
    </Show>
  )
}
