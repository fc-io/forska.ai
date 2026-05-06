import {expect, test} from '@playwright/test'

import {routeErrorSurfaceTestId} from '../../src/app/routerErrorSurface'
import {createBrowserFailureAssertions} from '../../src/app/utils/browserFailureAssertions'

import {buildTelemetryJob, installAdminTelemetryMocks} from './adminJudgmentJobTelemetryFixtures'

const telemetryScenarios = [
  {
    description: 'local prompt or request-work backlog needs replenishment',
    label: 'Underfed provider: claiming backlog',
    scenario: 'claiming' as const,
  },
  {
    description: 'endpoint probe, cooldown, or misconfiguration state',
    label: 'Endpoint unavailable: claiming held',
    scenario: 'endpointUnavailable' as const,
  },
  {
    description: 'allocated target while physical provider capacity remains below the hard cap',
    label: 'Provider at target',
    scenario: 'providerAtTarget' as const,
  },
  {
    description: 'Physical leased calls, including endpoint probes, reached the provider limit',
    label: 'Provider saturated',
    scenario: 'providerSaturated' as const,
  },
  {
    description: 'waiting for durable closeout, token-use, outbox, or owner ACK persistence',
    label: 'Completion persistence',
    scenario: 'completionPersistence' as const,
  },
]

const providerCapacityTelemetryHeadings = [
  'Provider Capacity Telemetry',
  'Admission Lease Snapshot',
  'Local Worker Diagnostics',
  'Observed Aggregate Telemetry',
  'Allocation State And Convergence',
  'Bottleneck Source Metadata',
  'Endpoint Diagnostics',
]

test('admin job detail web flow explains provider telemetry bottleneck states', async ({page}) => {
  const browserFailures = createBrowserFailureAssertions(page)

  try {
    for (const telemetryScenario of telemetryScenarios) {
      const job = buildTelemetryJob(telemetryScenario.scenario)

      await installAdminTelemetryMocks(page, job)
      await page.goto(`/admin/jobs/${job.id}`)

      await expect(page.getByRole('heading', {name: 'Job'})).toBeVisible()
      const providerCapacityTelemetry = page.getByTestId('provider-capacity-telemetry')

      await expect(providerCapacityTelemetry).toBeVisible()
      await expect(providerCapacityTelemetry.getByRole('heading')).toHaveText(providerCapacityTelemetryHeadings)
      await expect(page.getByRole('heading', {name: 'Request And Capacity Debug'})).toBeVisible()
      await expect(page.getByText(telemetryScenario.label)).toBeVisible()
      await expect(page.getByText(telemetryScenario.description)).toBeVisible()
      await expect(page.getByText('Bottleneck Source Metadata')).toBeVisible()
      await expect(page.getByText('Observed aggregates: best-effort partial')).toBeVisible()
      await expect(page.getByTestId(routeErrorSurfaceTestId)).toHaveCount(0)

      await page.unroute('**/api/**')
    }

    browserFailures.assertNoFailures()
  } finally {
    browserFailures.dispose()
  }
})
