import {useQuery} from '@tanstack/solid-query'
import {Link} from '@tanstack/solid-router'
import {createMemo, Show} from 'solid-js'

import {ReviewsIndexingProgress} from './reviewsIndexingProgress.tsx'
import {createReviewsWarningsQueryOptions} from './reviewsWarningsQuery.ts'

const formatQueuedAt = (value: string | null) => {
  const parsed = value ? new Date(value) : null

  return parsed === null || Number.isNaN(parsed.getTime())
    ? null
    : new Intl.DateTimeFormat(undefined, {dateStyle: 'medium', timeStyle: 'short'}).format(parsed)
}

const getPendingRefreshLabel = (pendingRefreshCount: number) => {
  return pendingRefreshCount === 1 ? '1 refresh job outstanding' : `${pendingRefreshCount} refresh jobs outstanding`
}

const getIndexingBannerTitle = (params: {
  pendingArticleRefreshCount: number
  pendingProjectRefreshCount: number
  status: 'not-needed' | 'ready' | 'refreshing' | 'stale'
}) => {
  return params.status === 'stale'
    ? 'Review index is catching up'
    : params.pendingArticleRefreshCount > 0 && params.pendingProjectRefreshCount === 0
      ? 'New judgments are still being incorporated'
      : 'Review indexing in progress'
}

const getIndexingBannerBody = (params: {
  pendingArticleRefreshCount: number
  pendingProjectRefreshCount: number
  status: 'not-needed' | 'ready' | 'refreshing' | 'stale'
}) => {
  return params.status === 'stale'
    ? 'This project has scoped articles, but the review index is missing or stale. Review lists may stay empty until the writer rebuilds the project.'
    : params.pendingProjectRefreshCount > 0 && params.pendingArticleRefreshCount > 0
      ? 'This project is still rebuilding its review index and folding in newly produced judgments. Counts and article lists may change until the backlog clears.'
      : params.pendingProjectRefreshCount > 0
        ? 'This project has scoped articles, but the review index is still updating in the background. Review lists may look partial or empty until indexing finishes.'
        : "New judgments are still being folded into this project's review index. Counts and article lists may change until the backlog clears."
}

const getPendingRefreshMetaLabel = (params: {
  pendingArticleRefreshCount: number
  pendingProjectRefreshCount: number
}) => {
  const segments = [
    params.pendingProjectRefreshCount > 0
      ? getPendingRefreshLabel(params.pendingProjectRefreshCount)
          .replace('refresh job', 'project refresh')
          .replace('refresh jobs', 'project refreshes')
      : null,
    params.pendingArticleRefreshCount > 0
      ? params.pendingArticleRefreshCount === 1
        ? '1 article judgment refresh outstanding'
        : `${params.pendingArticleRefreshCount} article judgment refreshes outstanding`
      : null,
  ].filter((value): value is string => {
    return value !== null
  })

  return segments.join(' and ')
}

export const ReviewsProjectWarnings = (props: {projectId: string}) => {
  const query = useQuery(() => {
    return createReviewsWarningsQueryOptions(props.projectId)
  })

  const warningsData = () => {
    return query.isSuccess ? (query.data ?? null) : null
  }

  const noEnabledPrompts = createMemo(() => {
    return (warningsData()?.enabledPromptCount ?? 0) === 0
  })

  const noArticlesInProject = createMemo(() => {
    const data = warningsData()
    if (!data) return false

    const hasEnabledPrompts = data.enabledPromptCount > 0
    const hasAnyArticlesInScope = data.scope.hasAnyArticlesInScope
    return hasEnabledPrompts && !hasAnyArticlesInScope
  })

  const showIndexingBanner = createMemo(() => {
    const status = warningsData()?.indexing.status ?? 'ready'

    return status === 'refreshing' || status === 'stale'
  })

  const indexingBannerTone = createMemo(() => {
    return warningsData()?.indexing.status === 'stale'
      ? 'bg-orange-50 border-orange-200 text-orange-900'
      : 'bg-sky-50 border-sky-200 text-sky-900'
  })

  const indexingBannerTitle = createMemo(() => {
    const data = warningsData()
    return !data ? 'Review indexing in progress' : getIndexingBannerTitle(data.indexing)
  })

  const indexingBannerBody = createMemo(() => {
    const data = warningsData()
    return !data
      ? 'This project has scoped articles, but the review index is still updating in the background. Review lists may look partial or empty until indexing finishes.'
      : getIndexingBannerBody(data.indexing)
  })

  const indexingBannerMeta = createMemo(() => {
    const data = warningsData()
    if (!data || data.indexing.pendingRefreshCount === 0) return null

    const queuedAtLabel = formatQueuedAt(data.indexing.oldestQueuedAt)
    const pendingLabel = getPendingRefreshMetaLabel(data.indexing)

    return queuedAtLabel ? `${pendingLabel} since ${queuedAtLabel}` : pendingLabel
  })

  return (
    <Show when={warningsData()}>
      <div class="space-y-3">
        <Show when={showIndexingBanner()}>
          <div class={`rounded-lg border p-4 ${indexingBannerTone()}`}>
            <p class="font-medium">{indexingBannerTitle()}</p>
            <p class="mt-1 text-sm opacity-90">{indexingBannerBody()}</p>
            <Show when={warningsData()?.indexing ?? null}>
              {(indexing) => {
                return <ReviewsIndexingProgress indexing={indexing()} />
              }}
            </Show>
            <Show when={indexingBannerMeta()}>
              {(meta) => {
                return <p class="mt-2 text-xs opacity-75">{meta()}</p>
              }}
            </Show>
          </div>
        </Show>

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
