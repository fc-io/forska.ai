import {readFileSync} from 'node:fs'

import {expect, test} from 'bun:test'

const readSource = (relativePath: string) => {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

test('project transfer heavy DuckDB flows carry workload contexts', () => {
  const routesSource = readSource('../../routes/projectTransferRoutes.ts')
  const exportSource = readSource('./projectTransferExport.ts')
  const exportPackageSource = readSource('./projectTransferExportPackage.ts')
  const analyzeTargetSource = readSource('./projectTransferAnalyzeTarget.ts')
  const operationTablesSource = readSource('./projectTransferOperationTables.ts')
  const commitSource = readSource('./projectTransferCommit.ts')
  const commitWriterSource = readSource('./projectTransferCommitWriter.ts')

  expect(routesSource).toContain('projectTransferRouteLookupWorkloadContext')
  expect(exportSource).toContain('projectTransferExportWorkloadContext')
  expect(exportPackageSource).toContain('projectTransferExportTransactionWorkloadContext')
  expect(analyzeTargetSource).toContain('projectTransferAnalyzeOperationWorkloadContext')
  expect(operationTablesSource).toContain('workloadContext?: DuckdbWorkloadContext')
  expect(commitSource).toContain('projectTransferCommitTransactionWorkloadContext')
  expect(commitWriterSource).toContain('projectTransferCommitTransactionWorkloadContext')
})

test('project transfer keeps source workflows owner-routed and not API-role raw serving', () => {
  const routeInventorySource = readSource('../../routes/routeSurfaceInventory.ts')
  const routeGuardSource = readSource('../../routes/duckdbRouteGuardrails.test.ts')

  expect(routeInventorySource).toContain("ownerDependentSensitive(\n    'projectTransferRoutes.ts'")
  expect(routeGuardSource).toContain("'src/server/routes/projectTransferRoutes.ts'")
})
