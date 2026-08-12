import {readFileSync} from 'node:fs'

import {expect, test} from 'bun:test'

const readSource = (relativePath: string) => {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

test('project transfer heavy DuckDB flows carry workload contexts', () => {
  const routesSource = readSource('../../routes/projectTransferRoutes.ts')
  const exportSource = readSource('./projectTransferExport.ts')
  const exportPackageSource = readSource('./projectTransferExportPackage.ts')
  const analyzeSource = readSource('./projectTransferAnalyze.ts')
  const analyzeTargetSource = readSource('./projectTransferAnalyzeTarget.ts')
  const operationTablesSource = readSource('./projectTransferOperationTables.ts')
  const commitSource = readSource('./projectTransferCommit.ts')
  const commitWriterSource = readSource('./projectTransferCommitWriter.ts')

  expect(routesSource).toContain('projectTransferRouteLookupWorkloadContext')
  expect(exportSource).toContain('projectTransferExportWorkloadContext')
  expect(exportPackageSource).not.toContain('projectTransferExportTransactionWorkloadContext')
  expect(exportPackageSource).toContain('stageProjectTransferExportPayloadRows({')
  expect(analyzeSource).toContain('runWithDuckdbExclusiveWork')
  expect(analyzeSource).toContain('getProjectTransferAnalyzeTargetPlanWithOperationTables')
  expect(analyzeTargetSource).toContain('projectTransferAnalyzeOperationWorkloadContext')
  expect(operationTablesSource).toContain('workloadContext?: DuckdbWorkloadContext')
  expect(commitSource).toContain('runWithDuckdbExclusiveWork')
  expect(commitSource).toContain('repositories.runAppTableWrites')
  expect(commitSource).toContain('projectTransferCommitTransactionWorkloadContext')
  expect(commitWriterSource).toContain('projectTransferCommitTransactionWorkloadContext')
})

test('project transfer exclusive DuckDB work stays scoped to heavy import phases', () => {
  const workloadSource = readSource('./projectTransferWorkloadContext.ts')
  const analyzeSource = readSource('./projectTransferAnalyze.ts')
  const commitSource = readSource('./projectTransferCommit.ts')
  const duckdbServiceSource = readSource('../../utils/duckdbService.ts')

  expect(workloadSource).toContain("routeOrJobKey: 'projectTransfer.session'")
  expect(workloadSource).toContain("routeOrJobKey: 'projectTransfer.recovery'")
  expect(workloadSource).toContain("routeOrJobKey: 'projectTransfer.recovery.scan'")
  expect(workloadSource).toContain("routeOrJobKey: 'projectTransfer.recovery.mutation'")
  expect(workloadSource).toContain("routeOrJobKey: 'projectTransfer.recovery.cleanup'")
  expect(workloadSource).toContain("routeOrJobKey: 'projectTransfer.export.queries'")
  expect(workloadSource).not.toContain('projectTransfer.export.transaction')
  expect(workloadSource).toContain("routeOrJobKey: 'projectTransfer.import.analyze.operationTables'")
  expect(workloadSource).toContain("routeOrJobKey: 'projectTransfer.import.commit.transaction'")

  expect(analyzeSource).toContain('input.runner === undefined')
  expect(analyzeSource).toContain('Waiting for DuckDB maintenance work to pause')
  expect(commitSource).toContain('Waiting for DuckDB maintenance work to pause')
  expect(workloadSource).not.toContain('projectTransfer.session.exclusive')
  expect(workloadSource).not.toContain('projectTransfer.recovery.exclusive')
  expect(duckdbServiceSource).not.toContain("'projectTransfer.export.queries',")
  expect(duckdbServiceSource).not.toContain("'projectTransfer.export.transaction',")
  expect(duckdbServiceSource).not.toContain("'projectTransfer.recovery',")
})

test('project transfer commit article create staging avoids duplicating full article JSON payloads', () => {
  const commitWriterSource = readSource('./projectTransferCommitWriter.ts')

  expect(commitWriterSource).not.toContain("json_extract(row_json, '$.article') AS article_json")
  expect(commitWriterSource).not.toContain("getArticleJsonFieldSql('create_row.article_json'")
  expect(commitWriterSource).toContain("getArticleJsonFieldSql('staged_article.payload_json'")
})

test('project transfer commit materializes set-based judgment rows once', () => {
  const commitWriterSource = readSource('./projectTransferCommitWriter.ts')

  expect(commitWriterSource).toContain('loadSetBasedJudgmentRowsWorkTable')
  expect(commitWriterSource).toContain('getSetBasedJudgmentRowsWorkSql(rowsTable)')
  expect(commitWriterSource).not.toContain(
    'const rowsSql = getSetBasedJudgmentRowsSql({context, now, projectId})\n  const expectedInsertCount',
  )
})

test('project transfer keeps source workflows owner-routed and not API-role raw serving', () => {
  const routeInventorySource = readSource('../../routes/routeSurfaceInventory.ts')
  const routeGuardSource = readSource('../../routes/duckdbRouteGuardrails.test.ts')

  expect(routeInventorySource).toContain("ownerDependentSensitive(\n    'projectTransferRoutes.ts'")
  expect(routeGuardSource).toContain("'src/server/routes/projectTransferRoutes.ts'")
})
