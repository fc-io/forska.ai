import {expect, test} from '@playwright/test'

import {routeErrorSurfaceTestId} from '../../src/app/routerErrorSurface'
import {createBrowserFailureAssertions} from '../../src/app/utils/browserFailureAssertions'

import {buildTelemetryJob, installAdminTelemetryMocks} from './adminJudgmentJobTelemetryFixtures'

test('admin job telemetry separates lease authority, observed aggregates, and local diagnostics', async ({page}) => {
  const browserFailures = createBrowserFailureAssertions(page)
  const job = buildTelemetryJob('claiming')

  try {
    await installAdminTelemetryMocks(page, job)
    await page.goto(`/admin/jobs/${job.id}`)

    await expect(page.getByRole('heading', {name: 'Provider Capacity Telemetry'})).toBeVisible()
    await expect(page.getByRole('heading', {name: 'Lease Authority'})).toBeVisible()
    await expect(page.getByRole('heading', {name: 'Local Worker Diagnostics'})).toBeVisible()
    await expect(page.getByRole('heading', {name: 'Observed Aggregate Telemetry'})).toBeVisible()
    await expect(page.getByText('Observed aggregates: best-effort partial')).toBeVisible()
    await expect(page.getByText('Some remote worker telemetry is stale or missing')).toBeVisible()
    await expect(page.getByText('Request leases are the shared admission authority')).toBeVisible()
    await expect(page.getByText('Local Prompt Backlog')).toBeVisible()
    await expect(page.getByText('Request-Work Backlog')).toBeVisible()
    await expect(page.getByText('Local Target And Lease Headroom')).toBeVisible()
    await expect(page.getByText('Underfed provider: claiming backlog')).toBeVisible()
    await expect(page.getByText('local prompt or request-work backlog needs replenishment')).toBeVisible()
    await expect(page.getByTestId(routeErrorSurfaceTestId)).toHaveCount(0)

    browserFailures.assertNoFailures()
  } finally {
    browserFailures.dispose()
  }
})

test('admin job telemetry shows endpoint probe state when claiming is held', async ({page}) => {
  const browserFailures = createBrowserFailureAssertions(page)
  const job = buildTelemetryJob('endpointUnavailable')

  try {
    await installAdminTelemetryMocks(page, job)
    await page.goto(`/admin/jobs/${job.id}`)

    await expect(page.getByText('Endpoint unavailable: claiming held')).toBeVisible()
    await expect(page.getByText('Claiming held by endpoint probe state')).toBeVisible()
    await expect(page.getByRole('heading', {name: 'Endpoint Diagnostics'})).toBeVisible()
    await expect(page.getByText('Cooldown')).toBeVisible()
    await expect(page.getByText('Provider endpoint outage: runtime returned 503')).toBeVisible()
    await expect(page.getByText('endpoint:provider-telemetry::https://runtime-paused.example.com')).toBeVisible()
    await expect(page.getByTestId(routeErrorSurfaceTestId)).toHaveCount(0)

    browserFailures.assertNoFailures()
  } finally {
    browserFailures.dispose()
  }
})
