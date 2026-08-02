import {readFileSync} from 'node:fs'
import {join} from 'node:path'

import {expect, test} from 'bun:test'

const projectRoot = process.cwd()

type PackageJson = {scripts: Record<string, string>}
type PackageScriptExpectation = {commandIncludes?: string[]; description: string; mustContain?: string[]; path?: string}

const readSource = (path: string) => {
  return readFileSync(join(projectRoot, path), 'utf8')
}

const packageScriptExpectations: Record<string, PackageScriptExpectation> = {
  'db:backup': {
    description: 'snapshot backup',
    mustContain: ['createDuckdbSnapshotForCli'],
    path: 'scripts/dbBackup.ts',
  },
  'db:duck:backfill-ppr-host-labels': {
    description: 'maintenance backfill',
    mustContain: ['withDuckdbMaintenanceAccess', "getMaintenanceDuckdbWorkloadContext('backfillPprHostLabels')"],
    path: 'scripts/backfillPprHostLabels.ts',
  },
  'db:duck:backfill-source-metadata': {
    description: 'maintenance backfill',
    mustContain: [
      'withDuckdbMaintenanceAccess',
      "getMaintenanceDuckdbWorkloadContext('backfillArticleSourceMetadata')",
    ],
    path: 'scripts/backfillArticleSourceMetadata.ts',
  },
  'db:duck:checkpoint': {
    description: 'maintenance checkpoint',
    mustContain: [
      'withDuckdbMaintenanceAccess',
      "getMaintenanceDuckdbWorkloadContext('duckdbCheckpoint')",
      "maintenance('checkpoint', workloadContext)",
    ],
    path: 'scripts/duckdbCheckpoint.ts',
  },
  'db:duck:legacy-inspect-dirty-refresh-risk': {
    commandIncludes: ['SERVER_ROLE=maintenance-worker', 'SERVER_DUCKDB_OWNER_URL='],
    description: 'legacy diagnostic maintenance read',
    mustContain: ['withDuckdbMaintenanceAccess', "getMaintenanceDuckdbWorkloadContext('inspectDirtyRefreshRisk')"],
    path: 'scripts/inspectDirtyRefreshRisk.ts',
  },
  'db:duck:inspect-review-serving-rebuild-timings': {
    commandIncludes: ['SERVER_ROLE=maintenance-worker', 'SERVER_DUCKDB_OWNER_URL='],
    description: 'V4 rebuild timing diagnostics',
    mustContain: [
      'withDuckdbMaintenanceAccess',
      "getMaintenanceDuckdbWorkloadContext('inspectReviewServingRebuildTimings')",
      'getReviewServingRebuildTimingDiagnostics',
      'getReviewServingPhysicalShapeDiagnostics',
      'physicalShape',
      'timeline',
      'defaultReadableAt',
      'fullyEnrichedAt',
    ],
    path: 'scripts/inspectReviewServingRebuildTimings.ts',
  },
  'db:duck:inspect-review-serving-project-state': {
    commandIncludes: ['DUCKDB_PATH=', 'runtime/primary/forska.duckdb'],
    description: 'V4 project state readonly snapshot diagnostics',
    mustContain: ['createDuckdbSnapshotForCli', 'getReadOnlyDuckdbRuntimeOptions', 'DuckDBInstance.create'],
    path: 'scripts/inspectReviewServingProjectState.ts',
  },
  'db:duck:inspect-review-serving-physical-evidence': {
    commandIncludes: ['DUCKDB_PATH=', 'runtime/primary/forska.duckdb'],
    description: 'V4 physical storage shape readonly snapshot diagnostics',
    mustContain: [
      'createDuckdbSnapshotForCli',
      'getReadOnlyDuckdbRuntimeOptions',
      'DuckDBInstance.create',
      "verdict: 'retired'",
      'no row, duplicate, index, or recoverability inspection was attempted',
      'Filtered-Count Serving Physical Evidence',
      'Summary Rebuild Accumulator Lifecycle Evidence',
      'Hot Payload Proxy Evidence',
      'hotPayloadProxyEvidence',
      'Selected-Import Staging Physical Evidence',
      'selectedImportStagingPhysicalEvidence',
      'mart.review_selected_article_import_staging_v4',
      'staging_row_id',
      'published_at IS NULL',
      'published_at IS NOT NULL',
      'Selected-base flag columns may already be retired/dropped; the protected contract is the retained identity plus hot-field/default fallback semantics.',
      'Selected-base duplicate flag column status:',
      'Selected-base/default duplicate false rows without hot fallback source:',
      'totalArrayMemberships',
      'maxArrayLength',
      'avgArrayLength',
      'approxStringBytes',
      'proof-only; not retention cleanup authorization',
      'not deletion authorization',
    ],
    path: 'scripts/inspectReviewServingPhysicalEvidence.ts',
  },
  'db:duck:mig': {commandIncludes: ['bun run db:mig'], description: 'migration alias'},
  'db:duck:legacy-quarantine-dirty-refresh-article': {
    commandIncludes: ['SERVER_ROLE=maintenance-worker', 'SERVER_DUCKDB_OWNER_URL='],
    description: 'legacy quarantine maintenance writer',
    mustContain: [
      'withDuckdbMaintenanceAccess',
      "getMaintenanceDuckdbWorkloadContext('quarantineDirtyRefreshArticle')",
      'requireLegacyAdminAck',
    ],
    path: 'scripts/quarantineDirtyRefreshArticle.ts',
  },
  'db:duck:rebuild2-cutover': {
    commandIncludes: ['SERVER_ROLE=maintenance-worker', 'SERVER_DUCKDB_OWNER_URL='],
    description: 'one-way maintenance cutover',
    mustContain: ['withDuckdbMaintenanceAccess', "getMaintenanceDuckdbWorkloadContext('rebuild2Cutover')"],
    path: 'scripts/rebuild2Cutover.ts',
  },
  'db:duck:legacy-recover-dirty-refresh-claims': {
    commandIncludes: ['SERVER_ROLE=maintenance-worker', 'SERVER_DUCKDB_OWNER_URL='],
    description: 'legacy claim recovery that enqueues V4 rebuilds',
    mustContain: [
      'withDuckdbMaintenanceAccess',
      "getMaintenanceDuckdbWorkloadContext('recoverDirtyRefreshClaims')",
      'requestReviewServingV4Rebuild',
      'requireLegacyAdminAck',
    ],
    path: 'scripts/recoverDirtyRefreshClaims.ts',
  },
  'db:duck:request-judgment-fact-repair': {
    commandIncludes: ['SERVER_ROLE=maintenance-worker', 'SERVER_DUCKDB_OWNER_URL='],
    description: 'V4 repair request',
    mustContain: [
      'withDuckdbMaintenanceAccess',
      "getMaintenanceDuckdbWorkloadContext('requestJudgmentFactRepair')",
      'requestReviewServingV4Rebuild',
    ],
    path: 'scripts/requestJudgmentFactRepair.ts',
  },
  'db:duck:request-review-serving-project-rebuild': {
    commandIncludes: ['SERVER_ROLE=maintenance-worker', 'SERVER_DUCKDB_OWNER_URL='],
    description: 'V4 project rebuild request',
    mustContain: [
      'withDuckdbMaintenanceAccess',
      "getMaintenanceDuckdbWorkloadContext('requestReviewServingProjectRebuild')",
      'requestReviewServingV4Rebuild',
    ],
    path: 'scripts/requestReviewServingProjectRebuild.ts',
  },
  'db:duck:request-review-serving-all-projects-rebuild': {
    commandIncludes: ['SERVER_ROLE=maintenance-worker', 'SERVER_DUCKDB_OWNER_URL='],
    description: 'V4 rebuild request',
    mustContain: [
      'withDuckdbMaintenanceAccess',
      "getMaintenanceDuckdbWorkloadContext('requestReviewServingAllProjectsRebuild')",
      'requestReviewServingV4Rebuild',
    ],
    path: 'scripts/requestReviewServingAllProjectsRebuild.ts',
  },
  'db:duck:release-failed-requestless-review-serving-rebuild-chunks': {
    commandIncludes: [
      'FORSKA_RUNTIME_PROFILE=primary',
      'DUCKDB_PATH="$HOME/Library/Application Support/Forska/runtime/primary/forska.duckdb"',
      'SERVER_ROLE=maintenance-worker',
      'SERVER_DUCKDB_OWNER_URL=',
    ],
    description: 'V4 failed requestless rebuild chunk release',
    mustContain: [
      'withDuckdbMaintenanceAccess',
      "getMaintenanceDuckdbWorkloadContext('releaseFailedRequestlessReviewServingRebuildChunks')",
      'releaseFailedRequestlessReviewServingRebuildChunks',
      'requiredApplyAcknowledgement',
      '--apply',
      '--project-id',
      '--request-id',
      'release-failed-requestless-review-rebuild-chunks-preserve-request-row',
      "mode: 'failed_requestless_chunk_release'",
    ],
    path: 'scripts/releaseFailedRequestlessReviewServingRebuildChunks.ts',
  },
  'db:duck:terminalize-review-serving-rebuild-request': {
    commandIncludes: ['SERVER_ROLE=maintenance-worker', 'SERVER_DUCKDB_OWNER_URL='],
    description: 'V4 rebuild request terminalization',
    mustContain: [
      'withDuckdbMaintenanceAccess',
      "getMaintenanceDuckdbWorkloadContext('terminalizeReviewServingRebuildRequest')",
      'terminalizeStaleZeroChunkReviewServingRebuildRequest',
      'requiredApplyAcknowledgement',
      '--apply',
      '--project-id',
      '--request-id',
      'no-cleanup-authorized',
    ],
    path: 'scripts/terminalizeReviewServingRebuildRequest.ts',
  },
  'db:duck:run-archived-project-bounded-cleanup': {
    commandIncludes: ['SERVER_ROLE=maintenance-worker', 'SERVER_DUCKDB_OWNER_URL='],
    description: 'bounded archived-project cleanup',
    mustContain: ['withDuckdbMaintenanceAccess', 'runArchivedProjectBoundedCleanup'],
    path: 'scripts/runArchivedProjectBoundedCleanup.ts',
  },
  'db:duck:legacy-unquarantine-dirty-refresh-article': {
    commandIncludes: ['SERVER_ROLE=maintenance-worker', 'SERVER_DUCKDB_OWNER_URL='],
    description: 'legacy quarantine maintenance writer',
    mustContain: [
      'withDuckdbMaintenanceAccess',
      "getMaintenanceDuckdbWorkloadContext('unquarantineDirtyRefreshArticle')",
      'requireLegacyAdminAck',
    ],
    path: 'scripts/unquarantineDirtyRefreshArticle.ts',
  },
  'db:judgment-job:repair': {
    description: 'job sqlite repair under maintenance access',
    mustContain: ['withDuckdbMaintenanceAccess'],
    path: 'scripts/runJudgmentJobRepair.ts',
  },
  'db:judgment-job:sqlite-import': {
    description: 'job sqlite outbox import under maintenance access',
    mustContain: ['withDuckdbMaintenanceAccess', 'runJudgmentJobSqliteOutboxImportCycle'],
    path: 'scripts/runJudgmentJobSqliteSingleJobImport.ts',
  },
  'db:mig': {
    commandIncludes: ['runWithRuntimeProfile.ts', '--mode duckdb-migration'],
    description: 'primary migration runtime profile',
  },
  'db:mig:secondary': {
    commandIncludes: ['runWithRuntimeProfile.ts', '--mode duckdb-migration'],
    description: 'secondary migration runtime profile',
  },
  'db:query:snapshot': {
    description: 'snapshot readonly query',
    mustContain: ['createDuckdbSnapshotForCli', 'getReadOnlyDuckdbRuntimeOptions', 'DuckDBInstance.create'],
    path: 'scripts/dbQuerySnapshot.ts',
  },
  'db:studio': {
    description: 'snapshot readonly studio',
    mustContain: ['createDuckdbSnapshotForCli', "'-readonly'"],
    path: 'scripts/dbStudio.ts',
  },
}

test('package-exposed db scripts are explicitly classified and guarded', async () => {
  const packageJson = (await globalThis.Bun.file(join(projectRoot, 'package.json')).json()) as PackageJson
  const dbScripts = Object.keys(packageJson.scripts)
    .filter((name) => {
      return name.startsWith('db:')
    })
    .sort()

  expect(dbScripts).toEqual(Object.keys(packageScriptExpectations).sort())

  for (const [name, expectation] of Object.entries(packageScriptExpectations)) {
    const command = packageJson.scripts[name] ?? ''

    for (const expectedText of expectation.commandIncludes ?? []) {
      expect(command, `${name} command should include ${expectedText}`).toContain(expectedText)
    }

    if (!expectation.path) {
      continue
    }

    const source = readSource(expectation.path)

    for (const expectedText of expectation.mustContain ?? []) {
      expect(source, `${name} (${expectation.description}) should include ${expectedText}`).toContain(expectedText)
    }
  }
})

test('package no longer exposes legacy mart refresh or large-rebuild worker scripts', async () => {
  const packageJson = (await globalThis.Bun.file(join(projectRoot, 'package.json')).json()) as PackageJson
  const commandSurface = Object.entries(packageJson.scripts)
    .map(([name, command]) => {
      return `${name} ${command}`
    })
    .join('\n')

  expect(commandSurface).not.toContain('runProjectMartRefreshWorker')
  expect(commandSurface).not.toContain('runProjectMartLargeRebuild')
  expect(commandSurface).not.toContain('project-mart-large-rebuild')
  expect(commandSurface).not.toContain('request-review-serving-large-rebuild')
  expect(packageJson.scripts['db:duck:inspect-dirty-refresh-risk']).toBeUndefined()
  expect(packageJson.scripts['db:duck:quarantine-dirty-refresh-article']).toBeUndefined()
  expect(packageJson.scripts['db:duck:unquarantine-dirty-refresh-article']).toBeUndefined()
  expect(packageJson.scripts['db:duck:recover-dirty-refresh-claims']).toBeUndefined()
})

test('review-serving physical evidence inspector reports proof-only hot payload proxies', () => {
  const source = readSource('scripts/inspectReviewServingPhysicalEvidence.ts')

  for (const expectedText of [
    'HotPayloadProxyEvidenceReport',
    'mart.review_article_filter_posting_serving_v4',
    "'article_ids'",
    'mart.review_unassessed_queue_serving_v4',
    "'prompt_ids'",
    'app.review_rebuild_chunk_manifest',
    "'diagnostics_json'",
    "'budget_json'",
    'CAST(COALESCE(SUM(COALESCE(array_length("${column}"), 0)), 0) AS BIGINT) AS totalArrayMemberships',
    'CAST(MAX(COALESCE(array_length("${column}"), 0)) AS BIGINT) AS maxArrayLength',
    'AVG(COALESCE(array_length("${column}"), 0)) AS avgArrayLength',
    'CAST(COALESCE(SUM(length(CAST("${column}" AS VARCHAR))), 0) AS BIGINT) AS approxStringBytes',
    'Missing required evidence column: ${column}',
    'Table is absent: ${table}',
    'not deletion authorization, field-slimming authorization, migration authorization, or runtime cleanup authorization',
  ]) {
    expect(source).toContain(expectedText)
  }
})

test('review-serving physical evidence inspector reports selected-import staging evidence', () => {
  const source = readSource('scripts/inspectReviewServingPhysicalEvidence.ts')

  for (const expectedText of [
    'SelectedImportStagingPhysicalEvidenceReport',
    'selectedImportStagingPhysicalEvidence',
    'mart.review_selected_article_import_staging_v4',
    "'staging row id'",
    "'publish identity'",
    "'staging_row_id'",
    "'publish_scope_key'",
    'published_at IS NULL',
    'published_at IS NOT NULL',
    'Selected-import staging evidence is read-only.',
    'Duplicate probes report duplicate key groups',
    'Selected-Import Staging Physical Evidence',
    'Global published staging rows:',
    'Global unpublished staging rows:',
    'Current-project published staging rows:',
    'Current-project unpublished staging rows:',
    'Sample duplicate key rows',
  ]) {
    expect(source).toContain(expectedText)
  }
})

test('review-serving rebuild timing inspector reports optional hot table physical shape JSON', () => {
  const source = readSource('scripts/inspectReviewServingRebuildTimings.ts')
  const helperSource = readSource('src/server/reviewServing/reviewServingPhysicalShapeDiagnostics.ts')

  for (const expectedText of [
    'getReviewServingPhysicalShapeDiagnostics',
    'physicalShape',
    'options.projectId',
    'operatorReadout',
    'const output = physicalShape',
    '{...diagnostics, operatorReadout, physicalShape}',
    '{...diagnostics, operatorReadout}',
  ]) {
    expect(source).toContain(expectedText)
  }

  for (const expectedText of [
    'mart.review_article_filter_posting_serving_v4',
    'mart.review_unassessed_queue_serving_v4',
    'mart.review_article_judgment_detail_serving_v4',
    'mart.review_selected_article_import_current_v4',
    'mart.review_selected_article_import_staging_v4',
    'mart.review_article_summary_rebuild_accumulator_v4',
    'FROM information_schema.tables',
    'array_length(${column})',
    "'article_ids'",
    "'prompt_ids'",
    'answered_original',
    'human_comment',
    'source_chunk_ids_key',
    'Approximate byte values are string-cast payload proxies',
  ]) {
    expect(helperSource).toContain(expectedText)
  }
})

test('review-serving rebuild request terminalization CLI is opt-in and dry-run first', () => {
  const source = readSource('scripts/terminalizeReviewServingRebuildRequest.ts')

  expect(source).toContain("apply: hasFlag('--apply')")
  expect(source).toContain('if (options.apply && options.acknowledgement !== requiredApplyAcknowledgement)')
  expect(source).toContain('Refusing --apply without --ack=')
  expect(source).toContain('acknowledgementRequiredForApply')
  expect(source).toContain("mode: 'zero_chunks'")
  expect(source).toContain('minimumAgeMinutes')
  expect(source).toContain('Missing required --project-id=<project-id>')
  expect(source).toContain('Missing required --request-id=<request-id>')
})

test('failed requestless review-serving rebuild chunk release CLI is opt-in and dry-run first', () => {
  const source = readSource('scripts/releaseFailedRequestlessReviewServingRebuildChunks.ts')

  expect(source).toContain("apply: hasFlag('--apply')")
  expect(source).toContain('if (options.apply && options.acknowledgement !== requiredApplyAcknowledgement)')
  expect(source).toContain('Refusing --apply without --ack=')
  expect(source).toContain('acknowledgementRequiredForApply')
  expect(source).toContain("mode: 'failed_requestless_chunk_release'")
  expect(source).toContain('Missing required --project-id=<project-id> for --apply')
  expect(source).toContain('Missing required --request-id=<request-id> for --apply')
  expect(source).toContain('Missing required --project-id=<project-id>')
  expect(source).toContain('Missing required --request-id=<request-id>')
})

test('direct non-test DB scripts are explicitly isolated', () => {
  expect(readSource('scripts/analyzeRecoveredJobOrphans.ts')).toContain(
    "getMaintenanceDuckdbWorkloadContext('analyzeRecoveredJobOrphans')",
  )
  expect(readSource('scripts/checkRecoveredJudgmentBatch.ts')).toContain(
    "getMaintenanceDuckdbWorkloadContext('checkRecoveredJudgmentBatch')",
  )
  expect(readSource('scripts/backfillFailedRequestDetails.ts')).toContain(
    "getMaintenanceDuckdbWorkloadContext('backfillFailedRequestDetails')",
  )
  expect(readSource('scripts/repairOwnedProjectPrompts.ts')).toContain(
    "getMaintenanceDuckdbWorkloadContext('repairOwnedProjectPrompts')",
  )
  expect(readSource('scripts/reconcileRecoveredJudgmentJob.ts')).toContain(
    "getMaintenanceDuckdbWorkloadContext('reconcileRecoveredJudgmentJob')",
  )
  expect(readSource('scripts/recoverJudgmentJobWithSystemSqlite.ts')).toContain(
    "getMaintenanceDuckdbWorkloadContext('recoverJudgmentJobWithSystemSqlite')",
  )
  expect(readSource('scripts/requestReviewServingForDirtyRefreshClaim.ts')).toContain(
    "getMaintenanceDuckdbWorkloadContext('requestReviewServingForDirtyRefreshClaim')",
  )
  expect(readSource('scripts/requestReviewServingForDirtyRefreshClaim.ts')).toContain('withDuckdbMaintenanceAccess')
  expect(readSource('scripts/requestReviewServingForDirtyRefreshClaim.ts')).toContain('requireLegacyAdminAck')
  expect(readSource('scripts/slimProviderMetadata.ts')).toContain('withDuckdbMaintenanceAccess')
  expect(readSource('scripts/slimProviderMetadata.ts')).toContain(
    "getMaintenanceDuckdbWorkloadContext('slimProviderMetadata')",
  )
  expect(readSource('scripts/benchmarkDuckdbAppendLanes.ts')).toContain('DUCKDB_PATH = duckdbPath')
  expect(readSource('scripts/benchmarkDuckdbAppendLanes.ts')).toContain('getTempDbPath')
})
