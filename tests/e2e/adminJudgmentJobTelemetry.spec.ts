import {expect, type Locator, type Page, test} from '@playwright/test'

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

const detailSectionHeadings = [
  'Job',
  'Work Definition',
  'Pipeline Summary',
  'Prompt Queue',
  'Request Activity',
  'Token Usage Timeline',
  'Request And Capacity Debug',
  ...providerCapacityTelemetryHeadings,
  'Storage And Import Flow',
  'Import Success / Failure',
  'Runtime Lease',
  'Repair Actions',
  'Danger Actions',
]

const longOpaqueValue = (prefix: string) => {
  return `${prefix}-${'0123456789abcdef'.repeat(16)}`
}

const assertPageHasNoHorizontalOverflow = async (page: Page) => {
  const hasNoHorizontalOverflow = await page.evaluate(() => {
    return document.documentElement.scrollWidth <= document.documentElement.clientWidth
  })

  expect(hasNoHorizontalOverflow).toBe(true)
}

const getTop = async (locator: Locator) => {
  return locator.evaluate((element) => {
    return element.getBoundingClientRect().top
  })
}

const expectBefore = async (first: Locator, second: Locator) => {
  expect(await getTop(first)).toBeLessThan(await getTop(second))
}

test('admin job telemetry separates admission leases, observed aggregates, and local diagnostics', async ({page}) => {
  const browserFailures = createBrowserFailureAssertions(page)
  const job = buildTelemetryJob('claiming')

  try {
    await installAdminTelemetryMocks(page, job)
    await page.goto(`/admin/jobs/${job.id}`)

    const providerCapacityTelemetry = page.getByTestId('provider-capacity-telemetry')

    await expect(providerCapacityTelemetry).toBeVisible()
    await expect(providerCapacityTelemetry.getByRole('heading')).toHaveText(providerCapacityTelemetryHeadings)
    await expect(page.getByRole('heading')).toHaveText(detailSectionHeadings)
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

test('admin job detail keeps lifecycle controls and blockers near the header', async ({page}) => {
  const browserFailures = createBrowserFailureAssertions(page)
  const job = {
    ...buildTelemetryJob('completionPersistence'),
    error: [`Long runtime error ${longOpaqueValue('error')}`],
    id: longOpaqueValue('job-detail'),
    judgingRuntime: {enabled: false, reason: `Judging runtime unavailable for ${longOpaqueValue('runtime')}`},
    status: 'paused',
    storageHealth: {
      ...buildTelemetryJob('completionPersistence').storageHealth,
      oldestUnexportedAgeMs: 61_000,
      outboxRowCount: 2,
      pendingCompletionAckCount: 0,
    },
    storageState: 'draining',
  }
  const workDefinitionHeading = page.getByRole('heading', {name: 'Work Definition'})
  const requestDebugHeading = page.getByRole('heading', {name: 'Request And Capacity Debug'})
  const runtimeNotice = page.getByText('Active SGLang runtime model: runtime-model-with-a-different-name')
  const judgingRuntimeWarning = page.getByText('Judging runtime unavailable for')
  const resumeBlockedGuidance = page.getByText('Resume is blocked while 2 local judgment row(s) export to DuckDB')
  const startCleanError = `Start clean failed for ${longOpaqueValue('start-clean')}`
  const preflightNotice = `Preflight completed for ${longOpaqueValue('preflight')}`

  try {
    await installAdminTelemetryMocks(page, job, {
      preflightNotice,
      providerRuntime: {
        activeModelNames: ['runtime-model-with-a-different-name'],
        providerKind: 'sglang',
        sourceMetadata: null,
        workerUrls: [],
      },
      startCleanError,
    })
    page.on('dialog', (dialog) => {
      return void dialog.accept()
    })
    await page.setViewportSize({height: 900, width: 1280})
    await page.goto(`/admin/jobs/${job.id}`)

    await expect(page.getByRole('heading', {name: 'Job'})).toBeVisible()
    await expect(page.getByRole('button', {exact: true, name: 'Start Job'})).toBeDisabled()
    await expect(page.getByRole('button', {exact: true, name: 'Start Job Clean'})).toBeVisible()
    await expect(runtimeNotice).toBeVisible()
    await expect(judgingRuntimeWarning).toBeVisible()
    await expect(resumeBlockedGuidance).toBeVisible()

    await expectBefore(page.getByRole('button', {exact: true, name: 'Start Job'}), workDefinitionHeading)
    await expectBefore(page.getByRole('button', {exact: true, name: 'Start Job Clean'}), workDefinitionHeading)
    await expectBefore(runtimeNotice, workDefinitionHeading)
    await expectBefore(judgingRuntimeWarning, workDefinitionHeading)
    await expectBefore(resumeBlockedGuidance, workDefinitionHeading)
    await expectBefore(runtimeNotice, requestDebugHeading)
    await expectBefore(judgingRuntimeWarning, requestDebugHeading)
    await expectBefore(resumeBlockedGuidance, requestDebugHeading)

    await page.getByRole('button', {exact: true, name: 'Start Job Clean'}).click()
    const actionError = page.getByText(startCleanError)

    await expect(actionError).toBeVisible()
    await expectBefore(actionError, workDefinitionHeading)
    await expectBefore(actionError, requestDebugHeading)

    await page.getByRole('button', {exact: true, name: 'Run Preflight'}).click()
    const actionNotice = page.getByText(preflightNotice)

    await expect(actionNotice).toBeVisible()
    await expectBefore(actionNotice, workDefinitionHeading)
    await expectBefore(actionNotice, requestDebugHeading)
    await expect(page.getByText(`Long runtime error ${longOpaqueValue('error')}`)).toBeVisible()
    await assertPageHasNoHorizontalOverflow(page)
    await expect(page.getByTestId(routeErrorSurfaceTestId)).toHaveCount(0)

    browserFailures.assertNoFailures()
  } finally {
    browserFailures.dispose()
  }
})

test('admin job detail avoids page-level overflow at mobile width with long diagnostics', async ({page}) => {
  const browserFailures = createBrowserFailureAssertions(page)
  const longEndpointIdentity = `https://runtime-paused.example.com/v1/${longOpaqueValue('endpoint-identity')}`
  const longEndpointKey = `${longOpaqueValue('provider-key')}::https://runtime-paused.example.com/${longOpaqueValue(
    'endpoint-key',
  )}`
  const longProviderKey = longOpaqueValue('provider-key')
  const baseJob = buildTelemetryJob('endpointUnavailable')
  const job = {
    ...baseJob,
    error: [`Provider error ${longOpaqueValue('provider-error')}`],
    id: longOpaqueValue('mobile-job'),
    requestStats: {
      ...baseJob.requestStats,
      providerTelemetry: {
        ...baseJob.requestStats.providerTelemetry,
        endpointDiagnostics: baseJob.requestStats.providerTelemetry.endpointDiagnostics.map((endpoint) => {
          return {
            ...endpoint,
            effectiveBaseURL: null,
            endpointAvailabilityKey: longEndpointKey,
            endpointIdentity: longEndpointIdentity,
            lastFailureMessage: `Provider endpoint outage ${longOpaqueValue('endpoint-failure')}`,
          }
        }),
        endpointDiagnosticsSummary: {
          ...baseJob.requestStats.providerTelemetry.endpointDiagnosticsSummary,
          providerKey: longProviderKey,
        },
        leaseAuthority: {...baseJob.requestStats.providerTelemetry.leaseAuthority, providerKey: longProviderKey},
        providerKey: longProviderKey,
      },
    },
  }

  try {
    await installAdminTelemetryMocks(page, job)
    await page.setViewportSize({height: 900, width: 390})
    await page.goto(`/admin/jobs/${job.id}`)

    await expect(page.getByRole('heading', {name: 'Job'})).toBeVisible()
    await expect(page.getByText(longEndpointIdentity)).toBeVisible()
    await expect(page.getByText(longEndpointKey)).toBeVisible()
    await expect(page.getByText(`Provider key: ${longProviderKey}`)).toHaveCount(2)
    await expect(page.getByText(`Provider error ${longOpaqueValue('provider-error')}`)).toBeVisible()
    await assertPageHasNoHorizontalOverflow(page)
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
