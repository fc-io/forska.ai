import {expect, test} from 'bun:test'

import {routeSurfaceRoutes} from '../routeSurfaceInventory.ts'
import type {DuckdbOwnerProxyRequestTemplate} from './duckdbOwnerProxyRequestTemplate.ts'
import {
  duckdbOwnerProxyTimeoutBudgets,
  duckdbOwnerStreamingProxyTimeoutMs,
  getDuckdbOwnerProxyBodyIdleTimeoutMs,
  getDuckdbOwnerProxyRetryTimeoutMs,
  getDuckdbOwnerProxyTimeoutMs,
  getDuckdbOwnerProxyTimeoutProfile,
} from './duckdbOwnerProxyTimeoutMs.ts'
import {shouldRetryDuckdbOwnerProxyRequest} from './forwardApiRequestToDuckdbOwner/duckdbOwnerProxyRetry.ts'

const ownerTemplate = (
  method: string,
  publicPathname: string,
  classification: DuckdbOwnerProxyRequestTemplate['classification'] = 'owner-dependent',
): DuckdbOwnerProxyRequestTemplate => {
  return {
    body: method === 'GET' ? null : new ArrayBuffer(0),
    classification,
    failClosedWithoutDuckdbOwner: classification === 'owner-dependent',
    headers: new Headers(),
    method,
    pathname: classification === 'owner-dependent' ? `/__duckdb-owner-rpc${publicPathname}` : publicPathname,
    search: '',
  }
}

const longDownloadRouteKeys = [
  'GET /api/projects/:id/export/:jobId/download',
  'GET /api/projects/export/:exportId/download',
  'POST /api/comparison-projects/:id/conflict-resolutions/export',
  'POST /api/comparison-projects/:id/covidence-export',
  'POST /api/comparison-projects/:id/export',
  'POST /api/projects/:id/export-project',
  'POST /api/projects/:id/export-prompts',
]

const longDownloadRequests = [
  ['POST', '/api/comparison-projects/cov9/covidence-export'],
  ['POST', '/api/comparison-projects/cov9/export'],
  ['POST', '/api/comparison-projects/cov9/conflict-resolutions/export'],
  ['GET', '/api/projects/p1/export/job-1/download'],
  ['POST', '/api/projects/p1/export-prompts'],
  ['POST', '/api/projects/p1/export-project'],
  ['GET', '/api/projects/export/export-1/download'],
] as const

test('the inventory marks exactly the owner-proxied file downloads as long-download', () => {
  const markedRouteKeys = routeSurfaceRoutes
    .filter((route) => {
      return route.proxyTimeoutProfile === 'long-download'
    })
    .map((route) => {
      return `${route.method} ${route.path}`
    })
    .sort()

  expect(markedRouteKeys).toEqual(longDownloadRouteKeys)
  expect(
    routeSurfaceRoutes.every((route) => {
      return route.proxyTimeoutProfile === undefined || route.proxyClassification === 'owner-dependent'
    }),
  ).toBe(true)
})

test('long-download routes wait 10 minutes for headers, then use the 60 s body idle budget', () => {
  expect(duckdbOwnerProxyTimeoutBudgets.longDownloadTimeoutMs).toBe(duckdbOwnerStreamingProxyTimeoutMs)
  expect(duckdbOwnerStreamingProxyTimeoutMs).toBe(600_000)

  for (const [method, pathname] of longDownloadRequests) {
    const requestTemplate = ownerTemplate(method, pathname)

    expect({pathname, profile: getDuckdbOwnerProxyTimeoutProfile(requestTemplate)}).toEqual({
      pathname,
      profile: 'long-download',
    })
    expect(getDuckdbOwnerProxyTimeoutMs(requestTemplate)).toBe(600_000)
    expect(getDuckdbOwnerProxyBodyIdleTimeoutMs(requestTemplate)).toBe(60_000)
  }
})

test('trailing slashes and injected budgets resolve the same long-download profile', () => {
  const requestTemplate = ownerTemplate('POST', '/api/comparison-projects/cov9/covidence-export/')
  const budgets = {
    diagnosticTimeoutMs: 1,
    longDownloadBodyIdleTimeoutMs: 2,
    longDownloadTimeoutMs: 3,
    mutationTimeoutMs: 4,
    readTimeoutMs: 5,
  }

  expect(getDuckdbOwnerProxyTimeoutMs(requestTemplate, budgets)).toBe(3)
  expect(getDuckdbOwnerProxyBodyIdleTimeoutMs(requestTemplate, budgets)).toBe(2)
})

test('default routes keep the 60 s read/mutation and 3 s diagnostics budgets with no idle timer', () => {
  const defaultRequests = [
    ownerTemplate('POST', '/api/comparison-projects/cov9/covidence-export/count'),
    ownerTemplate('POST', '/api/comparison-projects/cov9/judgments'),
    ownerTemplate('GET', '/api/comparison-projects/cov9'),
    ownerTemplate('POST', '/api/projects/p1/export'),
    ownerTemplate('GET', '/api/projects/p1/export/job-1'),
    ownerTemplate('GET', '/api/projects/export/export-1'),
    ownerTemplate('PUT', '/api/projects/import/session-1/upload'),
    ownerTemplate('GET', '/api/runtime-asset'),
    ownerTemplate('POST', '/api/not-in-inventory', 'unclassified'),
  ]

  for (const requestTemplate of defaultRequests) {
    expect({pathname: requestTemplate.pathname, profile: getDuckdbOwnerProxyTimeoutProfile(requestTemplate)}).toEqual({
      pathname: requestTemplate.pathname,
      profile: 'default',
    })
    expect(getDuckdbOwnerProxyTimeoutMs(requestTemplate)).toBe(60_000)
    expect(getDuckdbOwnerProxyBodyIdleTimeoutMs(requestTemplate)).toBeNull()
  }

  expect(
    getDuckdbOwnerProxyTimeoutMs(
      ownerTemplate('GET', '/api/admin/duckdb-runtime-workloads', 'duckdb-owner-diagnostics'),
    ),
  ).toBe(3000)
  expect(getDuckdbOwnerProxyTimeoutMs(ownerTemplate('GET', '/api/llmstatus'))).toBe(3000)
})

test('POST downloads are never retried; retry budgets are unchanged', () => {
  for (const [method, pathname] of longDownloadRequests) {
    const requestTemplate = ownerTemplate(method, pathname)

    expect({pathname, retry: shouldRetryDuckdbOwnerProxyRequest(requestTemplate)}).toEqual({
      pathname,
      retry: method === 'GET',
    })
  }

  expect(
    getDuckdbOwnerProxyRetryTimeoutMs(ownerTemplate('POST', '/api/comparison-projects/cov9/covidence-export')),
  ).toBe(4000)
  expect(getDuckdbOwnerProxyRetryTimeoutMs(ownerTemplate('GET', '/api/projects/p1/export/job-1/download'))).toBe(15_000)
  expect(
    getDuckdbOwnerProxyRetryTimeoutMs(ownerTemplate('POST', '/api/comparison-projects/cov9/conflict-resolution')),
  ).toBe(180_000)
})
