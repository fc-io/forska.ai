import {describe, expect, test} from 'bun:test'

import type {ReviewsWarningsData} from '../reviewsWarningsQuery.ts'
import {
  getReviewArticlesIndexingRefreshSignature,
  getReviewArticlesRefetchInterval,
  resetReviewArticlesCursorPagination,
} from './reviewsArticleIndexingRefresh.ts'

const getWarningsData = (indexing: Partial<ReviewsWarningsData['indexing']> = {}): ReviewsWarningsData => {
  return {
    indexing: {
      coverage: {
        countReadyArticleCount: 3,
        detailReadyArticleCount: 3,
        filterReadyArticleCount: 3,
        reviewPageReadyArticleCount: 3,
        rowReadyArticleCount: 3,
        searchReadyArticleCount: 3,
        totalArticleCount: 3,
      },
      lastProcessedAt: '2026-09-15T10:00:00.000Z',
      lastProgressedAt: '2026-09-15T10:00:00.000Z',
      progressState: 'completed',
      serving: {readable: true, usable: true},
      status: 'ready',
      ...indexing,
    },
  } as ReviewsWarningsData
}

describe('review article indexing refresh helpers', () => {
  test('polls article lists while review-serving indexing is still converging', () => {
    expect(getReviewArticlesRefetchInterval(getWarningsData({progressState: 'processing'}))).toBe(2_000)
    expect(getReviewArticlesRefetchInterval(getWarningsData({progressState: 'queued'}))).toBe(2_000)
    expect(getReviewArticlesRefetchInterval(getWarningsData({progressState: 'stalled'}))).toBe(2_000)
    expect(getReviewArticlesRefetchInterval(getWarningsData({status: 'refreshing'}))).toBe(2_000)
    expect(getReviewArticlesRefetchInterval(getWarningsData({status: 'stale'}))).toBe(2_000)
  })

  test('does not poll stable article lists after indexing is ready', () => {
    expect(getReviewArticlesRefetchInterval(getWarningsData())).toBe(false)
    expect(getReviewArticlesRefetchInterval(null)).toBe(false)
  })

  test('changes the refresh signature when readiness coverage advances', () => {
    const before = getReviewArticlesIndexingRefreshSignature(
      getWarningsData({
        coverage: {
          countReadyArticleCount: 3,
          detailReadyArticleCount: 0,
          filterReadyArticleCount: 3,
          reviewPageReadyArticleCount: 3,
          rowReadyArticleCount: 3,
          searchReadyArticleCount: 3,
          totalArticleCount: 3,
        },
        progressState: 'processing',
        status: 'refreshing',
      }),
    )
    const after = getReviewArticlesIndexingRefreshSignature(getWarningsData())

    expect(before).not.toBe(after)
  })

  test('resets cursor pagination state after indexing changes', () => {
    let currentPage = 3
    let pageCursors: Record<number, string | null> = {1: null, 2: 'cursor-2', 3: 'cursor-3'}
    let loadedPages: Record<number, {data: string[]}> = {1: {data: ['article-1']}, 2: {data: ['article-2']}}

    resetReviewArticlesCursorPagination<{data: string[]}>({
      setCurrentPage: (page) => {
        currentPage = page
      },
      setLoadedPages: (pages) => {
        loadedPages = pages
      },
      setPageCursors: (cursors) => {
        pageCursors = cursors
      },
    })

    expect(currentPage).toBe(1)
    expect(pageCursors).toEqual({1: null})
    expect(loadedPages).toEqual({})
  })
})
