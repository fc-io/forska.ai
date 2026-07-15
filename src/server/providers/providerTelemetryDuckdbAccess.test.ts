import {readFileSync} from 'node:fs'

import {expect, test} from 'bun:test'

const readSource = (path: string) => {
  return readFileSync(path, 'utf8')
}

const providerAdmissionLeaseSource = readSource('src/server/cron/judgmentsJobs/providerAdmissionLease.ts')
const judgmentDispatchTelemetrySource = readSource('src/server/cron/judgmentsJobs/judgmentDispatchTelemetry.ts')
const providerConnectionRepositorySource = readSource('src/server/providers/providerConnectionRepository.ts')
const providerModelRepositorySource = readSource('src/server/providers/providerModelRepository.ts')
const providerModelRoutesSource = readSource('src/server/routes/ProviderModelsRoutes.ts')
const routeSurfaceInventorySource = readSource('src/server/routes/routeSurfaceInventory.ts')

const providerDbSources = [
  providerAdmissionLeaseSource,
  judgmentDispatchTelemetrySource,
  providerConnectionRepositorySource,
  providerModelRepositorySource,
  providerModelRoutesSource,
]

test('provider admission and repository DuckDB calls carry scoped workload contexts', () => {
  expect(providerAdmissionLeaseSource).toContain("workloadClass: 'background.providerAdmissionLease'")
  expect(providerAdmissionLeaseSource).toContain('providerAdmissionLeaseTelemetryRequestWorkloadContext')
  expect(providerAdmissionLeaseSource).toContain('providerAdmissionLeaseTelemetryProbeWorkloadContext')
  expect(providerAdmissionLeaseSource).toContain('providerAdmissionLeaseAcquireWorkloadContext')
  expect(providerAdmissionLeaseSource).toContain('providerAdmissionLeaseReconcileWorkloadContext')

  expect(providerConnectionRepositorySource).toContain("workloadClass: 'owner.providerRepository'")
  expect(providerConnectionRepositorySource).toContain('providerConnectionListWorkloadContext')
  expect(providerConnectionRepositorySource).toContain('providerConnectionCreateWorkloadContext')
  expect(providerConnectionRepositorySource).toContain('providerConnectionUpdateWorkloadContext')
  expect(providerConnectionRepositorySource).toContain('providerConnectionDeleteWorkloadContext')

  expect(providerModelRepositorySource).toContain("workloadClass: 'owner.providerRepository'")
  expect(providerModelRepositorySource).toContain('providerModelListSelectableWorkloadContext')
  expect(providerModelRepositorySource).toContain('providerModelCreateWorkloadContext')
  expect(providerModelRepositorySource).toContain('providerModelUpdateWorkloadContext')
  expect(providerModelRepositorySource).toContain('providerModelUpsertDiscoveredWorkloadContext')
  expect(providerModelRepositorySource).toContain('providerModelNaturalKeyLookupWorkloadContext')
  expect(providerModelRoutesSource).toContain('providerModelRouteWorkloadContext')
})

test('provider telemetry and repository paths avoid product-review raw scan shapes', () => {
  const forbiddenReviewScanPatterns = [
    /selected_scoped_article_import/i,
    /\bROW_NUMBER\s*\(/i,
    /\bapp\.article\b/i,
    /\bmart\.project_scope_article\b/i,
    /\bmart\.review_article_serving(?:_v4)?\b/i,
    /duckdbOlap/i,
  ]

  providerDbSources.map((source) => {
    forbiddenReviewScanPatterns.map((pattern) => {
      expect(source).not.toMatch(pattern)
    })
  })
})

test('provider routes remain owner or internal-runtime scoped', () => {
  expect(routeSurfaceInventorySource).toContain("ownerDependentSensitive(\n    'ProviderConnectionsRoutes.ts'")
  expect(routeSurfaceInventorySource).toContain("ownerDependentProduct('ProviderModelsRoutes.ts'")
  expect(routeSurfaceInventorySource).toContain("internalRuntime('providerAdmissionLeaseRoutes.ts'")
})
