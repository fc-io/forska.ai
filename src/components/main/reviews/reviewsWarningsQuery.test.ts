import {expect, mock, test} from 'bun:test'

await mock.module('../../../services/apiClient.ts', () => {
  return {apiClient: {}}
})

const {
  createReviewServingStatusQueryOptions,
  createReviewsWarningsQueryOptions,
  invalidateReviewsWarningsQueries,
  reviewServingStatusQueryKey,
  reviewsWarningsPollingIntervalMs,
  reviewsWarningsQueryKeyPrefix,
} = await import('./reviewsWarningsQuery.ts')

test('reviews warnings and review-serving status poll every 30 s and always refetch on mount, focus, and reconnect', () => {
  const expectedPolling = {
    refetchInterval: 30_000,
    refetchOnMount: 'always',
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  }

  expect(reviewsWarningsPollingIntervalMs).toBe(30_000)
  expect(createReviewsWarningsQueryOptions('project-1')).toMatchObject({
    ...expectedPolling,
    queryKey: [reviewsWarningsQueryKeyPrefix, 'project-1'],
  })
  expect(createReviewServingStatusQueryOptions()).toMatchObject({
    ...expectedPolling,
    queryKey: reviewServingStatusQueryKey,
  })
})

test('invalidating review warnings queries targets the warnings prefix and the review-serving status key', async () => {
  const invalidatedQueryKeys: unknown[] = []
  const queryClient = {
    invalidateQueries: async (filters: {queryKey: unknown}) => {
      invalidatedQueryKeys.push(filters.queryKey)
    },
  }

  await invalidateReviewsWarningsQueries(queryClient as never)

  expect(invalidatedQueryKeys).toEqual([['project-reviews-warnings'], ['review-serving-status']])
})
