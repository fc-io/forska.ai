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
const ownerRoutedProjectRoutes = [...projectTransferRouteSpecs, csvExportRoute]

test('project transfer routes and CSV export route proxy to the DuckDB owner and fail closed without one', () => {
  const results = ownerRoutedProjectRoutes.map((route) => {
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
    ownerRoutedProjectRoutes.map((route) => {
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

test('owner-private project transfer routes and CSV export route do not re-proxy', () => {
  const results = ownerRoutedProjectRoutes.map((route) => {
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
    ownerRoutedProjectRoutes.map((route) => {
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
