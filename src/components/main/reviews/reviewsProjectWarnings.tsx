import {useQuery} from '@tanstack/solid-query'
import {Link} from '@tanstack/solid-router'
import {createMemo, Show} from 'solid-js'

import {getReviewIndexingInProgressTitle} from './getReviewIndexingInProgressTitle.ts'
import {ReviewsIndexingProgress} from './reviewsIndexingProgress.tsx'
import {createReviewsWarningsQueryOptions, type ReviewsWarningsData} from './reviewsWarningsQuery.ts'

const formatQueuedAt = (value: string | null) => {
  const parsed = value ? new Date(value) : null

  return parsed === null || Number.isNaN(parsed.getTime())
    ? null
    : new Intl.DateTimeFormat(undefined, {dateStyle: 'medium', timeStyle: 'short'}).format(parsed)
}

const getPendingRefreshLabel = (pendingRefreshCount: number) => {
  return pendingRefreshCount === 1 ? '1 refresh job outstanding' : `${pendingRefreshCount} refresh jobs outstanding`
}

const getIndexingBannerTitle = (
  params: {
    largeRebuild: null | {rebuildPhase: string | null}
    pendingArticleRefreshCount: number
    pendingProjectRefreshCount: number
    status: 'failed' | 'not-needed' | 'ready' | 'refreshing' | 'stale'
  },
  projectId: string,
) => {
  return params.status === 'failed'
    ? params.largeRebuild?.rebuildPhase
      ? `Large rebuild failed: ${params.largeRebuild.rebuildPhase}`
      : 'Review indexing failed'
    : params.status === 'stale'
      ? 'Review index is catching up'
      : params.largeRebuild?.rebuildPhase
        ? `Large rebuild in progress: ${params.largeRebuild.rebuildPhase}`
        : params.pendingArticleRefreshCount > 0 && params.pendingProjectRefreshCount === 0
          ? 'New judgments are still being incorporated'
          : getReviewIndexingInProgressTitle(projectId)
}

const getIndexingBannerBody = (params: {
  largeRebuild: null | {
    cursorArticleCreatedAt: string | null
    cursorArticleId: string | null
    lastError: string | null
    rebuildPhase: string | null
  }
  pendingArticleRefreshCount: number
  pendingProjectRefreshCount: number
  status: 'failed' | 'not-needed' | 'ready' | 'refreshing' | 'stale'
}) => {
  return params.status === 'failed'
    ? params.largeRebuild?.lastError
      ? `Large rebuild failed: ${params.largeRebuild.lastError}`
      : 'The latest review index refresh failed, so review lists may be stale or incomplete until the writer retries the project.'
    : params.status === 'stale'
      ? 'This project has scoped articles, but the review index is missing or stale. Review lists may stay empty until the writer rebuilds the project.'
      : params.largeRebuild?.rebuildPhase
        ? 'This project is being rebuilt in bounded stages to avoid large-refresh crashes. Review lists and counts may change until the staged rebuild finishes.'
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

const getLargeRebuildDetailLabel = (data: ReviewsWarningsData | null) => {
  const phaseLabel = data?.indexing.largeRebuild?.rebuildPhase
  const cursorArticleId = data?.indexing.largeRebuild?.cursorArticleId

  return phaseLabel === undefined || phaseLabel === null
    ? null
    : cursorArticleId
      ? `Resuming from article ${cursorArticleId}`
      : `Large rebuild in progress: ${phaseLabel}`
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

    return status === 'failed' || status === 'refreshing' || status === 'stale'
  })

  const indexingBannerTone = createMemo(() => {
    return warningsData()?.indexing.status === 'failed'
      ? 'bg-rose-50 border-rose-200 text-rose-900'
      : warningsData()?.indexing.status === 'stale'
        ? 'bg-orange-50 border-orange-200 text-orange-900'
        : 'bg-sky-50 border-sky-200 text-sky-900'
  })

  const indexingBannerTitle = createMemo(() => {
    const data = warningsData()
    return !data
      ? getReviewIndexingInProgressTitle(props.projectId)
      : getIndexingBannerTitle(data.indexing, props.projectId)
  })

  const indexingBannerBody = createMemo(() => {
    const data = warningsData()
    return !data
      ? 'This project has scoped articles, but the review index is still updating in the background. Review lists may look partial or empty until indexing finishes.'
      : getIndexingBannerBody(data.indexing)
  })

  const indexingBannerMeta = createMemo(() => {
    const data = warningsData()
    if (!data) return null

    const largeRebuildLabel = getLargeRebuildDetailLabel(data)
    const queuedAtLabel = formatQueuedAt(data.indexing.oldestQueuedAt)
    const pendingLabel =
      data.indexing.pendingRefreshCount === 0 ? null : getPendingRefreshMetaLabel(data.indexing)
    const parts = [largeRebuildLabel, pendingLabel ? (queuedAtLabel ? `${pendingLabel} since ${queuedAtLabel}` : pendingLabel) : null].filter(
      (value): value is string => {
        return value !== null
      },
    )

    return parts.length === 0 ? null : parts.join(' • ')
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
