import {expect, mock, test} from 'bun:test'

await mock.module('../../../services/apiClient.ts', () => {
  return {apiClient: {}}
})

const {createReviewServingStatusQueryOptions, createReviewsWarningsQueryOptions, reviewsWarningsPollingIntervalMs} =
  await import('./reviewsWarningsQuery.ts')

test('reviews warnings and review-serving status poll every 30 s and refetch on mount, focus, and reconnect', () => {
  const expectedPolling = {
    refetchInterval: 30_000,
    refetchOnMount: true,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  }

  expect(reviewsWarningsPollingIntervalMs).toBe(30_000)
  expect(createReviewsWarningsQueryOptions('project-1')).toMatchObject({
    ...expectedPolling,
    queryKey: ['project-reviews-warnings', 'project-1'],
  })
  expect(createReviewServingStatusQueryOptions()).toMatchObject({
    ...expectedPolling,
    queryKey: ['review-serving-status'],
  })
})
