import {expect, test} from 'bun:test'

import {getRouteSurfaceRouteKey, routeSurfaceRoutes} from '../routes/routeSurfaceInventory.ts'
import {
  getReviewServingAdjacentRouteClassificationKey,
  reviewServingAdjacentRouteClassifications,
} from './reviewServingAdjacentRouteSurfaces.ts'
import {reviewServingReadContractKeys} from './reviewServingContracts.ts'

const requiredUs013SurfaceKeys = [
  'GET /api/articles/latest',
  'GET /api/articles/search',
  'GET /api/projects/:id/articles',
  'POST /api/projects/:id/articles',
  'DELETE /api/projects/:id/articles/:articleId',
  'GET /api/judgmentsjobs-unassessed-count',
  'GET /api/judgmentsjobs-unassessed-articles',
  'GET /api/humanassessment/overview',
  'GET /api/humanassessment/overview-both-projects',
  'POST /api/humanassessment/init',
  'POST /api/humanassessment/submit',
] as const

test('US-013 adjacent article and human-assessment surfaces are explicitly classified', () => {
  const classifiedKeys = reviewServingAdjacentRouteClassifications.map(getReviewServingAdjacentRouteClassificationKey)

  expect(classifiedKeys).toEqual([...requiredUs013SurfaceKeys])
})

test('US-013 review-flow adjacent surfaces delegate to serving or admission paths', () => {
  const reviewFlowEntries = reviewServingAdjacentRouteClassifications.filter((entry) => {
    return !entry.excludedFromNormalReviewFlow
  })

  expect(
    reviewFlowEntries.map((entry) => {
      return [entry.method, entry.routePath, entry.classification, entry.contractKeys, entry.guard]
    }),
  ).toEqual([
    [
      'POST',
      '/api/humanassessment/init',
      'migrated-serving',
      ['review.queue.unassessed'],
      'project access guard plus reviewServingReader queue admission with queueKind=human-unreviewed',
    ],
    [
      'POST',
      '/api/humanassessment/submit',
      'migrated-admission',
      [],
      'project access guard plus human judgment delta and dirty-refresh admission hooks',
    ],
  ])
})

test('US-013 out-of-scope adjacent surfaces are guarded and excluded from normal review flows', () => {
  const outOfScopeEntries = reviewServingAdjacentRouteClassifications.filter((entry) => {
    return entry.classification.startsWith('out-of-scope')
  })
  const unguardedEntries = outOfScopeEntries.filter((entry) => {
    return entry.guard.trim() === '' || entry.reason.trim() === '' || !entry.excludedFromNormalReviewFlow
  })

  expect(unguardedEntries).toEqual([])
  expect(
    outOfScopeEntries.map((entry) => {
      return [entry.method, entry.routePath, entry.classification]
    }),
  ).toEqual([
    ['GET', '/api/articles/latest', 'out-of-scope-non-review'],
    ['GET', '/api/articles/search', 'out-of-scope-non-review'],
    ['GET', '/api/projects/:id/articles', 'out-of-scope-non-review'],
    ['GET', '/api/judgmentsjobs-unassessed-count', 'out-of-scope-admin-debug'],
    ['GET', '/api/judgmentsjobs-unassessed-articles', 'out-of-scope-admin-debug'],
    ['GET', '/api/humanassessment/overview', 'out-of-scope-admin-debug'],
    ['GET', '/api/humanassessment/overview-both-projects', 'out-of-scope-admin-debug'],
  ])
})

test('US-013 adjacent serving classifications reference registered contracts only', () => {
  const knownContractKeys = new Set(reviewServingReadContractKeys)
  const unknownContractKeys = reviewServingAdjacentRouteClassifications.flatMap((entry) => {
    return entry.contractKeys.filter((contractKey) => {
      return !knownContractKeys.has(contractKey)
    })
  })

  expect(unknownContractKeys).toEqual([])
})

test('US-013 admin/debug adjacent surfaces are not product-classified in route inventory', () => {
  const routeSurfaceByKey = new Map(
    routeSurfaceRoutes.map((route) => {
      return [getRouteSurfaceRouteKey(route), route]
    }),
  )
  const productClassifiedAdminDebugRoutes = reviewServingAdjacentRouteClassifications.flatMap((entry) => {
    const routeSurface = routeSurfaceByKey.get(getReviewServingAdjacentRouteClassificationKey(entry))

    return entry.classification === 'out-of-scope-admin-debug' && routeSurface?.category === 'supported-local-api'
      ? [`${entry.method} ${entry.routePath}`]
      : []
  })

  expect(productClassifiedAdminDebugRoutes).toEqual([])
})
