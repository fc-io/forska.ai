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
  'GET /api/articles/:id',
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
    ['GET', '/api/articles/:id', 'out-of-scope-source-detail'],
    ['GET', '/api/projects/:id/articles', 'out-of-scope-non-review'],
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

test('US-013 admin UI adjacent surfaces stay product-classified in route inventory', () => {
  const routeSurfaceByKey = new Map(
    routeSurfaceRoutes.map((route) => {
      return [getRouteSurfaceRouteKey(route), route]
    }),
  )
  const adminDebugRouteCategories = reviewServingAdjacentRouteClassifications.flatMap((entry) => {
    const routeSurface = routeSurfaceByKey.get(getReviewServingAdjacentRouteClassificationKey(entry))

    return entry.classification === 'out-of-scope-admin-debug'
      ? [`${entry.method} ${entry.routePath} ${routeSurface?.category ?? 'missing'}`]
      : []
  })

  expect(adminDebugRouteCategories).toEqual([
    'GET /api/humanassessment/overview supported-local-api',
    'GET /api/humanassessment/overview-both-projects supported-local-api',
  ])
})

test('US-013 source article detail stays outside normal review detail fallback', () => {
  const routeSurfaceByKey = new Map(
    routeSurfaceRoutes.map((route) => {
      return [getRouteSurfaceRouteKey(route), route]
    }),
  )
  const articleDetail = reviewServingAdjacentRouteClassifications.find((entry) => {
    return entry.method === 'GET' && entry.routePath === '/api/articles/:id'
  })
  const routeSurface = articleDetail
    ? routeSurfaceByKey.get(getReviewServingAdjacentRouteClassificationKey(articleDetail))
    : undefined

  expect(articleDetail).toMatchObject({
    classification: 'out-of-scope-source-detail',
    excludedFromNormalReviewFlow: true,
  })
  expect(routeSurface?.category).toBe('sensitive-local-api')
})

test('US-013 migrated judgment job adjacent surfaces stay product-classified in route inventory', () => {
  const routeSurfaceByKey = new Map(
    routeSurfaceRoutes.map((route) => {
      return [getRouteSurfaceRouteKey(route), route]
    }),
  )
  const migratedJobRouteCategories = reviewServingAdjacentRouteClassifications.flatMap((entry) => {
    const routeSurface = routeSurfaceByKey.get(getReviewServingAdjacentRouteClassificationKey(entry))

    return entry.classification === 'migrated-job'
      ? [`${entry.method} ${entry.routePath} ${routeSurface?.category ?? 'missing'}`]
      : []
  })

  expect(migratedJobRouteCategories).toEqual([
    'GET /api/judgmentsjobs-unassessed-count supported-local-api',
    'GET /api/judgmentsjobs-unassessed-articles supported-local-api',
  ])
})
