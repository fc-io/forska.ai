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
