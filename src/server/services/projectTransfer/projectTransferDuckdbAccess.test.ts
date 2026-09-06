import {readFileSync} from 'node:fs'

import {expect, test} from 'bun:test'

const readSource = (relativePath: string) => {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8').replaceAll('\r\n', '\n')
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
  const commitAppWritesStart = commitSource.indexOf('const runProjectTransferCommitAppTableWrites =')
  const commitAppWritesEnd = commitSource.indexOf('\nconst settleCompletionSideEffect', commitAppWritesStart)
  const commitAppWritesSource = commitSource.slice(commitAppWritesStart, commitAppWritesEnd)

  expect(routesSource).toContain('projectTransferRouteLookupWorkloadContext')
  const uploadStart = routesSource.indexOf('const uploadImportPackage = async')
  const uploadEnd = routesSource.indexOf('\nconst analyzeImportSession = async', uploadStart)
  const uploadSource = routesSource.slice(uploadStart, uploadEnd)

  expect(uploadStart).toBeGreaterThanOrEqual(0)
  expect(uploadEnd).toBeGreaterThan(uploadStart)
  expect(uploadSource).toContain('return runProjectTransferImportWorkerHeartbeat({')
  expect(uploadSource).toContain('return runWithDuckdbExclusiveWork(')
  expect(uploadSource).toContain("phase: 'upload'")
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
  expect(commitAppWritesStart).toBeGreaterThanOrEqual(0)
  expect(commitAppWritesEnd).toBeGreaterThan(commitAppWritesStart)
  expect(commitAppWritesSource).toContain('runner: database')
  expect(commitAppWritesSource).toContain('workloadContext: projectTransferCommitTransactionWorkloadContext')
  expect(commitAppWritesSource.indexOf('return withProjectTransferOperationTables({')).toBeLessThan(
    commitAppWritesSource.indexOf('return database.transaction('),
  )
  expect(commitAppWritesSource).not.toContain('runner: tx')
  expect(commitSource).toContain(
    'await writeCommitProgressArtifact({progress: heartbeatProgress, runtimeOptions, sessionId})',
  )
  expect(commitSource).toContain('await Promise.all(pendingHeartbeats)')
  expect(commitWriterSource).toContain('projectTransferCommitTransactionWorkloadContext')
})

test('project transfer exclusive DuckDB work stays scoped to heavy import phases', () => {
  const workloadSource = readSource('./projectTransferWorkloadContext.ts')
  const analyzeSource = readSource('./projectTransferAnalyze.ts')
  const commitSource = readSource('./projectTransferCommit.ts')
  const exclusiveWorkSource = readSource('./projectTransferDuckdbExclusiveWork.ts')
  const duckdbServiceSource = readSource('../../utils/duckdbService.ts')

  expect(workloadSource).toContain("routeOrJobKey: 'projectTransfer.session'")
  expect(workloadSource).toContain("routeOrJobKey: 'projectTransfer.recovery'")
  expect(workloadSource).toContain(
    "projectTransferRecoveryScanWorkloadContext = getProjectTransferWorkloadContext({\n  allowsTempSpill: true,\n  fallbackIntent: 'reject',\n  routeOrJobKey: 'projectTransfer.recovery.scan'",
  )
  expect(workloadSource).toContain("routeOrJobKey: 'projectTransfer.recovery.scan'")
  expect(workloadSource).toContain("routeOrJobKey: 'projectTransfer.recovery.mutation'")
  expect(workloadSource).toContain("routeOrJobKey: 'projectTransfer.recovery.cleanup'")
  expect(workloadSource).toContain("routeOrJobKey: 'projectTransfer.export.queries'")
  expect(workloadSource).not.toContain('projectTransfer.export.transaction')
  expect(workloadSource).toContain("routeOrJobKey: 'projectTransfer.import.analyze.operationTables'")
  expect(workloadSource).toContain("routeOrJobKey: 'projectTransfer.import.commit.transaction'")

  expect(analyzeSource).toContain('input.runner === undefined')
  expect(analyzeSource).toContain('Waiting for DuckDB maintenance work to pause')
  expect(analyzeSource).toContain('const analyzeProjectTransferImportPackageCore = async')
  expect(analyzeSource).toContain('return analyzeProjectTransferImportPackageCore(input, exclusiveWorkLease)')
  expect(analyzeSource.match(/runWithDuckdbExclusiveWork\(/gu)).toHaveLength(1)
  expect(analyzeSource).toContain('return analyze(lease)')
  expect(analyzeSource).toContain(': analyze(null)')
  expect(analyzeSource).toContain('await exclusiveWorkLease?.release()')
  expect(analyzeSource.indexOf('const initialPlan = getPlanArtifact')).toBeLessThan(
    analyzeSource.indexOf('await exclusiveWorkLease?.release()'),
  )
  expect(analyzeSource.indexOf('await exclusiveWorkLease?.release()')).toBeLessThan(
    analyzeSource.indexOf('const resolvedAnalyzePlan = await getAnalyzePlanWithAutoResolvedDependencies'),
  )
  expect(exclusiveWorkSource).toContain('operation: (lease: DuckdbExclusiveWorkLease) => Promise<T>')
  expect(exclusiveWorkSource).toContain('return operation(lease)')
  expect(commitSource).toContain('Waiting for DuckDB maintenance work to pause')
  expect(workloadSource).not.toContain('projectTransfer.session.exclusive')
  expect(workloadSource).not.toContain('projectTransfer.recovery.exclusive')
  expect(duckdbServiceSource).toContain("'projectTransfer.session',")
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

test('project transfer production commit streams full judgments into compact source-id records', () => {
  const commitSource = readSource('./projectTransferCommit.ts')
  const compactLoaderStart = commitSource.indexOf('const readCompactExtractedJudgments =')
  const compactLoaderEnd = commitSource.indexOf('\nconst getPackageCount =', compactLoaderStart)
  const compactLoaderSource = commitSource.slice(compactLoaderStart, compactLoaderEnd)

  expect(compactLoaderStart).toBeGreaterThanOrEqual(0)
  expect(compactLoaderEnd).toBeGreaterThan(compactLoaderStart)
  expect(compactLoaderSource).toContain('createInterface({')
  expect(compactLoaderSource).toContain("assertProjectTransferPayloadRow('judgments'")
  expect(compactLoaderSource).toContain('records.push({sourceJudgmentId: row.sourceJudgmentId})')
  expect(compactLoaderSource).not.toContain('.text()')
  expect(compactLoaderSource).not.toContain('parseProjectTransferPayload')
  expect(commitSource.match(/retainCompactJudgments: true/gu)).toHaveLength(1)
  expect(commitSource).toContain('return parseProjectTransferPayload(input.key, text)')
})

test('project transfer keeps source workflows owner-routed and not API-role raw serving', () => {
  const routeInventorySource = readSource('../../routes/routeSurfaceInventory.ts')
  const routeGuardSource = readSource('../../routes/duckdbRouteGuardrails.test.ts')

  expect(routeInventorySource).toContain("ownerDependentSensitive(\n    'projectTransferRoutes.ts'")
  expect(routeGuardSource).toContain("'src/server/routes/projectTransferRoutes.ts'")
})
