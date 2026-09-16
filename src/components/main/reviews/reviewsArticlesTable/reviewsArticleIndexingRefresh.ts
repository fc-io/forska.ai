import type {ReviewsWarningsData} from '../reviewsWarningsQuery.ts'

type CursorPaginationResetInput<LoadedPage> = {
  setCurrentPage: (page: number) => void
  setLoadedPages: (pages: Record<number, LoadedPage>) => void
  setPageCursors: (cursors: Record<number, string | null>) => void
}

const activeIndexingProgressStates = new Set<ReviewsWarningsData['indexing']['progressState']>([
  'processing',
  'queued',
  'stalled',
])

const activeIndexingStatuses = new Set<ReviewsWarningsData['indexing']['status']>(['refreshing', 'stale'])

export const getReviewArticlesRefetchInterval = (warningsData: ReviewsWarningsData | null | undefined) => {
  const indexing = warningsData?.indexing

  if (!indexing) {
    return false
  }

  return activeIndexingProgressStates.has(indexing.progressState) || activeIndexingStatuses.has(indexing.status)
    ? 2_000
    : false
}

export const getReviewArticlesIndexingRefreshSignature = (
  warningsData: ReviewsWarningsData | null | undefined,
): string | null => {
  const indexing = warningsData?.indexing

  if (!indexing) {
    return null
  }

  const coverage = indexing.coverage

  return [
    indexing.progressState,
    indexing.status,
    indexing.lastProgressedAt ?? '',
    indexing.lastProcessedAt ?? '',
    indexing.serving.readable ? 'readable' : 'unreadable',
    indexing.serving.usable ? 'usable' : 'unusable',
    coverage.totalArticleCount,
    coverage.countReadyArticleCount ?? 'count-null',
    coverage.filterReadyArticleCount ?? 'filter-null',
    coverage.detailReadyArticleCount ?? 'detail-null',
    coverage.rowReadyArticleCount ?? 'row-null',
    coverage.searchReadyArticleCount ?? 'search-null',
  ].join('|')
}

export const resetReviewArticlesCursorPagination = <LoadedPage>({
  setCurrentPage,
  setLoadedPages,
  setPageCursors,
}: CursorPaginationResetInput<LoadedPage>) => {
  setCurrentPage(1)
  setPageCursors({1: null})
  setLoadedPages({})
}
