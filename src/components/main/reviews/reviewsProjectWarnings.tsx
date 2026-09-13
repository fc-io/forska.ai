import {useQuery} from '@tanstack/solid-query'
import {Link} from '@tanstack/solid-router'
import {createMemo, Show} from 'solid-js'

import {getReviewIndexingStateCopy} from './getReviewIndexingInProgressTitle.ts'
import {ReviewsIndexingProgress} from './reviewsIndexingProgress.tsx'
import {
  createReviewServingStatusQueryOptions,
  createReviewsWarningsQueryOptions,
  type ReviewsWarningsData,
} from './reviewsWarningsQuery.ts'

const formatQueuedAt = (value: string | null) => {
  const parsed = value ? new Date(value) : null

  return parsed === null || Number.isNaN(parsed.getTime())
    ? null
    : new Intl.DateTimeFormat(undefined, {dateStyle: 'medium', timeStyle: 'short'}).format(parsed)
}

const formatCount = (value: number) => {
  return new Intl.NumberFormat().format(value)
}

const getPendingBackgroundMaintenanceLabel = (params: {indexing: ReviewsWarningsData['indexing']}) => {
  const diagnostics = params.indexing.serving.diagnostics
  const pendingRebuildChunkCount =
    (diagnostics.rebuildChunks?.pendingCount ?? 0) + (diagnostics.rebuildChunks?.runningCount ?? 0)
  const pendingDirtyWorkCount = (diagnostics.dirtyWork?.pendingCount ?? 0) + (diagnostics.dirtyWork?.runningCount ?? 0)

  return pendingRebuildChunkCount + pendingDirtyWorkCount === 0 ? null : 'background maintenance queued'
}

const getArticleCountLabel = (count: number) => {
  return `${formatCount(count)} ${count === 1 ? 'article' : 'articles'}`
}

const isReadyCoverage = (readyCount: number | null, totalArticleCount: number) => {
  return totalArticleCount > 0 && readyCount === totalArticleCount
}

const hasReadyReviewRows = (indexing: ReviewsWarningsData['indexing']) => {
  return isReadyCoverage(indexing.coverage.rowReadyArticleCount, indexing.coverage.totalArticleCount)
}

const hasReadyReviewCounts = (indexing: ReviewsWarningsData['indexing']) => {
  return isReadyCoverage(indexing.coverage.countReadyArticleCount, indexing.coverage.totalArticleCount)
}

const hasReadyReviewFilters = (indexing: ReviewsWarningsData['indexing']) => {
  return isReadyCoverage(indexing.coverage.filterReadyArticleCount, indexing.coverage.totalArticleCount)
}

const hasReadyReviewDetails = (indexing: ReviewsWarningsData['indexing']) => {
  return isReadyCoverage(indexing.coverage.detailReadyArticleCount, indexing.coverage.totalArticleCount)
}

const hasReadyReviewSurfaces = (indexing: ReviewsWarningsData['indexing']) => {
  const totalArticleCount = indexing.coverage.totalArticleCount
  const searchReadyArticleCount = indexing.coverage.searchReadyArticleCount
  const hasSearchReady =
    searchReadyArticleCount === null
      ? indexing.search.availability === 'unavailable'
      : searchReadyArticleCount === totalArticleCount

  return (
    hasReadyReviewRows(indexing)
    && hasReadyReviewCounts(indexing)
    && hasReadyReviewFilters(indexing)
    && hasReadyReviewDetails(indexing)
    && hasSearchReady
  )
}

const getPendingReadySurfaceNames = (indexing: ReviewsWarningsData['indexing']) => {
  const totalArticleCount = indexing.coverage.totalArticleCount
  const searchReadyArticleCount = indexing.coverage.searchReadyArticleCount
  const hasSearchReady =
    searchReadyArticleCount === null
      ? indexing.search.availability === 'unavailable'
      : totalArticleCount > 0 && searchReadyArticleCount === totalArticleCount

  return [
    hasReadyReviewCounts(indexing) ? null : 'counts',
    hasReadyReviewFilters(indexing) ? null : 'filters',
    hasReadyReviewDetails(indexing) ? null : 'details',
    hasSearchReady ? null : 'search',
  ].filter((value): value is string => {
    return value !== null
  })
}

const getJoinedLabel = (values: readonly string[]) => {
  return values.length <= 2 ? values.join(' and ') : `${values.slice(0, -1).join(', ')} and ${values.at(-1)}`
}

const getPendingProjectRefreshMetaLabel = (params: {
  indexing: ReviewsWarningsData['indexing']
  pendingProjectRefreshCount: number
}) => {
  if (params.pendingProjectRefreshCount === 0) {
    return null
  }

  const totalArticleCount = params.indexing.coverage.totalArticleCount
  if (totalArticleCount > 0 && !hasReadyReviewRows(params.indexing)) {
    return `Preparing review list and counts for ${getArticleCountLabel(totalArticleCount)}`
  }

  const pendingSurfaceNames = getPendingReadySurfaceNames(params.indexing)
  if (totalArticleCount > 0 && pendingSurfaceNames.length > 0) {
    return `Finishing ${getJoinedLabel(pendingSurfaceNames)} for ${getArticleCountLabel(totalArticleCount)}`
  }

  return params.pendingProjectRefreshCount === 1
    ? '1 review index update remaining'
    : `${formatCount(params.pendingProjectRefreshCount)} review index updates remaining`
}

const getPendingRefreshMetaLabel = (params: {
  indexing: ReviewsWarningsData['indexing']
  pendingArticleRefreshCount: number
  pendingProjectRefreshCount: number
}) => {
  const readySurfaceMaintenanceLabel = hasReadyReviewSurfaces(params.indexing)
    ? getPendingBackgroundMaintenanceLabel({indexing: params.indexing})
    : null
  const segments = [
    readySurfaceMaintenanceLabel ?? getPendingProjectRefreshMetaLabel(params),
    params.pendingArticleRefreshCount > 0
      ? params.pendingArticleRefreshCount === 1
        ? '1 article judgment refresh remaining'
        : `${formatCount(params.pendingArticleRefreshCount)} article judgment refreshes remaining`
      : null,
  ].filter((value): value is string => {
    return value !== null
  })

  return segments.length === 0 ? '' : `Background work: ${segments.join(' and ')}`
}

export const ReviewsProjectWarnings = (props: {projectId: string}) => {
  const query = useQuery(() => {
    return createReviewsWarningsQueryOptions(props.projectId)
  })
  const statusQuery = useQuery(() => {
    return createReviewServingStatusQueryOptions()
  })

  const warningsData = () => {
    return query.isSuccess ? (query.data ?? null) : null
  }

  const showOwnerlessRecoveryStatus = () => {
    return warningsData() === null && statusQuery.data?.pauseMarker.exists === true
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

    return (
      status === 'blocked'
      || status === 'failed'
      || status === 'refreshing'
      || status === 'stale'
      || (warningsData()?.indexing.cleanup?.inFlightGenerationCleanupCount ?? 0) > 0
    )
  })

  const indexingBannerTone = createMemo(() => {
    return warningsData()?.indexing.status === 'failed'
      ? 'bg-rose-50 border-rose-200 text-rose-900'
      : warningsData()?.indexing.status === 'blocked' || warningsData()?.indexing.status === 'stale'
        ? 'bg-orange-50 border-orange-200 text-orange-900'
        : 'bg-sky-50 border-sky-200 text-sky-900'
  })

  const indexingBannerCopy = createMemo(() => {
    const data = warningsData()
    return data === null
      ? null
      : getReviewIndexingStateCopy({indexing: data.indexing, projectId: data.projectId, surface: 'banner'})
  })

  const indexingBannerTitle = createMemo(() => {
    return indexingBannerCopy()?.title ?? null
  })

  const indexingBannerBody = createMemo(() => {
    return indexingBannerCopy()?.description ?? null
  })

  const indexingBannerMeta = createMemo(() => {
    const data = warningsData()
    if (!data) return null

    const queuedAtLabel = formatQueuedAt(data.indexing.oldestQueuedAt)
    const pendingLabel =
      data.indexing.pendingRefreshCount === 0
        ? null
        : getPendingRefreshMetaLabel({
            indexing: data.indexing,
            pendingArticleRefreshCount: data.indexing.pendingArticleRefreshCount,
            pendingProjectRefreshCount: data.indexing.pendingProjectRefreshCount,
          })
    const parts = [
      pendingLabel ? (queuedAtLabel ? `${pendingLabel} since ${queuedAtLabel}` : pendingLabel) : null,
    ].filter((value): value is string => {
      return value !== null
    })

    return parts.length === 0 ? null : parts.join(' • ')
  })

  return (
    <>
      <Show when={showOwnerlessRecoveryStatus()}>
        <div class="rounded-lg border border-orange-200 bg-orange-50 p-4 text-orange-900">
          <p class="font-medium">Review indexing recovering after memory pressure</p>
          <p class="mt-1 text-sm opacity-90">
            Review pages remain available while the maintenance worker recovers. Review refresh work will resume
            automatically once the runtime is ready.
          </p>
        </div>
      </Show>
      <Show when={warningsData()}>
        <div class="space-y-3">
          <Show when={showIndexingBanner()}>
            <div class={`rounded-lg border p-4 ${indexingBannerTone()}`}>
              <p class="font-medium">{indexingBannerTitle()}</p>
              <p class="mt-1 text-sm opacity-90">{indexingBannerBody()}</p>
              <p class="mt-2 break-all text-xs opacity-75">
                Project ID: {warningsData()?.projectId ?? props.projectId}
              </p>
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
    </>
  )
}
