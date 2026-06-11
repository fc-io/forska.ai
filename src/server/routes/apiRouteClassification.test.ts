import {expect, test} from 'bun:test'

import {
  classifyApiRoute,
  duckdbOwnerPrivateApiPrefix,
  getDuckdbOwnerProxyPathname,
  shouldApiRouteFailClosedWithoutDuckdbOwner,
  shouldApiRouteProxyToDuckdbOwner,
} from './apiRouteClassification.ts'
import {projectTransferRouteSpecs} from './projectTransferRoutes.ts'

const csvExportRoute = {endpoint: 'csv-export', method: 'POST', samplePath: '/api/projects/project-1/export'} as const
const comparisonJudgmentsRoute = {
  endpoint: 'comparison-judgments',
  method: 'POST',
  samplePath: '/api/comparison-projects/comparison-project-1/judgments',
} as const
const comparisonJudgmentsCountRoute = {
  endpoint: 'comparison-judgments-count',
  method: 'POST',
  samplePath: '/api/comparison-projects/comparison-project-1/judgments/count',
} as const
const runningJudgmentJobsRoute = {
  endpoint: 'running-judgment-jobs',
  method: 'GET',
  samplePath: '/api/judgmentsjobs-running',
} as const
const judgmentJobUnassessedArticlesRoute = {
  endpoint: 'judgment-job-unassessed-articles',
  method: 'GET',
  samplePath: '/api/judgmentsjobs-unassessed-articles',
} as const
const judgmentJobUnassessedCountRoute = {
  endpoint: 'judgment-job-unassessed-count',
  method: 'GET',
  samplePath: '/api/judgmentsjobs-unassessed-count',
} as const
const runtimeAssetRoute = {endpoint: 'runtime-asset', method: 'GET', samplePath: '/api/runtime-asset'} as const
const ownerRoutedRoutes = [
  ...projectTransferRouteSpecs,
  comparisonJudgmentsRoute,
  comparisonJudgmentsCountRoute,
  csvExportRoute,
  judgmentJobUnassessedArticlesRoute,
  judgmentJobUnassessedCountRoute,
  runningJudgmentJobsRoute,
  runtimeAssetRoute,
]

test('owner-backed routes proxy to the DuckDB owner and fail closed without one', () => {
  const results = ownerRoutedRoutes.map((route) => {
    const classification = classifyApiRoute(route.samplePath, route.method)

    return {
      classification,
      endpoint: route.endpoint,
      failClosed: shouldApiRouteFailClosedWithoutDuckdbOwner(classification),
      proxyPathname: getDuckdbOwnerProxyPathname({classification, pathname: route.samplePath}),
      shouldProxy: shouldApiRouteProxyToDuckdbOwner(classification),
    }
  })

  expect(results).toEqual(
    ownerRoutedRoutes.map((route) => {
      return {
        classification: 'owner-dependent',
        endpoint: route.endpoint,
        failClosed: true,
        proxyPathname: `${duckdbOwnerPrivateApiPrefix}${route.samplePath}`,
        shouldProxy: true,
      }
    }),
  )
})

test('owner-private owner-backed routes do not re-proxy', () => {
  const results = ownerRoutedRoutes.map((route) => {
    const pathname = `${duckdbOwnerPrivateApiPrefix}${route.samplePath}`
    const classification = classifyApiRoute(pathname, route.method)

    return {
      classification,
      endpoint: route.endpoint,
      failClosed: shouldApiRouteFailClosedWithoutDuckdbOwner(classification),
      proxyPathname: getDuckdbOwnerProxyPathname({classification, pathname}),
      shouldProxy: shouldApiRouteProxyToDuckdbOwner(classification),
    }
  })

  expect(results).toEqual(
    ownerRoutedRoutes.map((route) => {
      const pathname = `${duckdbOwnerPrivateApiPrefix}${route.samplePath}`

      return {
        classification: 'non-api',
        endpoint: route.endpoint,
        failClosed: false,
        proxyPathname: pathname,
        shouldProxy: false,
      }
    }),
  )
})
