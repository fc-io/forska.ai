import {expect, test} from '@playwright/test'

import {routeErrorSurfaceTestId} from '../../src/app/routerErrorSurface'
import {createBrowserFailureAssertions} from '../../src/app/utils/browserFailureAssertions'

import {buildTelemetryJob, installAdminTelemetryMocks} from './adminJudgmentJobTelemetryFixtures'

const providerCapacityTelemetryHeadings = [
  'Provider Capacity Telemetry',
  'Admission Lease Snapshot',
  'Local Worker Diagnostics',
  'Observed Aggregate Telemetry',
  'Allocation State And Convergence',
  'Bottleneck Source Metadata',
  'Endpoint Diagnostics',
]

test('admin job telemetry separates admission leases, observed aggregates, and local diagnostics', async ({page}) => {
  const browserFailures = createBrowserFailureAssertions(page)
  const job = buildTelemetryJob('claiming')

  try {
    await installAdminTelemetryMocks(page, job)
    await page.goto(`/admin/jobs/${job.id}`)

    const providerCapacityTelemetry = page.getByTestId('provider-capacity-telemetry')

    await expect(providerCapacityTelemetry).toBeVisible()
    await expect(providerCapacityTelemetry.getByRole('heading')).toHaveText(providerCapacityTelemetryHeadings)
    await expect(page.getByRole('heading', {name: 'Request And Capacity Debug'})).toBeVisible()
    await expect(page.getByText('Observed aggregates: best-effort partial')).toBeVisible()
    await expect(page.getByText('Some remote worker telemetry is stale or missing')).toBeVisible()
    await expect(page.getByText('Request leases are the shared admission authority')).toBeVisible()
    await expect(page.getByText('Local Prompt Backlog')).toBeVisible()
    await expect(page.getByText('Request-Work Backlog')).toBeVisible()
    await expect(page.getByText('Local Target And Lease Headroom')).toBeVisible()
    await expect(page.getByText('Worker Prompt Slots', {exact: true})).toHaveCount(1)
    await expect(page.getByText('Worker Queued Prompts', {exact: true})).toHaveCount(1)
    await expect(page.getByText('Prompt Prefetch Fill', {exact: true})).toHaveCount(1)
    await expect(page.getByText('Request Slot Waiters', {exact: true})).toHaveCount(1)
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
