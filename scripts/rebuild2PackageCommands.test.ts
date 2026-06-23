import {join} from 'node:path'

import {expect, test} from 'bun:test'

const projectRoot = process.cwd()

test('package exposes final rebuild2 command surface and removes obsolete mart refresh queue commands', async () => {
  const packageJson = (await globalThis.Bun.file(join(projectRoot, 'package.json')).json()) as {
    scripts: Record<string, string>
  }
  const obsoleteCommandMatches = Object.entries(packageJson.scripts)
    .filter(([name, command]) => {
      return (
        `${name} ${command}`.includes('refresh-queue')
        || `${name} ${command}`.includes('db:duck:rebuild-marts')
        || `${name} ${command}`.includes('db:duck:backfill-review-serving-v3')
        || `${name} ${command}`.includes('db:duck:refresh-project-once')
        || `${name} ${command}`.includes('db:duck:run-large-rebuild-cycle')
        || `${name} ${command}`.includes('db:duck:run-large-rebuild-cycles')
        || command.includes('backfillReviewServingV3')
        || command.includes('runProjectMartLargeRebuildCycle.ts')
        || command.includes('runProjectMartLargeRebuildCycles.ts')
        || `${name} ${command}`.includes('quarantine-refresh-article')
        || `${name} ${command}`.includes('inspect-project-refresh-risk')
        || `${name} ${command}`.includes('recover-project-refresh-claims')
        || `${name} ${command}`.includes('repair-project-refresh-ledger')
        || `${name} ${command}`.includes('repair-judgment-fact')
        || `${name} ${command}`.includes('purge-archived-marts')
        || command.includes('recoverArchivedProjectRefreshQueue')
        || command.includes('quarantineProjectMartRefreshArticle')
        || command.includes('unquarantineProjectMartRefreshArticle')
        || command.includes('inspectProjectMartRefreshRisk')
        || command.includes('recoverProjectMartRefreshClaims')
        || command.includes('repairProjectMartRefreshLedger')
        || command.includes('repairJudgmentFactTable')
        || command.includes('purgeArchivedProjectMarts')
        || command.includes('reproArchivedProjectServingDelete')
      )
    })
    .map(([name]) => {
      return name
    })

  expect(packageJson.scripts['db:duck:rebuild2-cutover']).toBe(
    'SERVER_ROLE=maintenance-worker SERVER_DUCKDB_OWNER_URL= bun scripts/rebuild2Cutover.ts',
  )
  expect(packageJson.scripts['db:duck:request-project-large-rebuild']).toBe(
    'SERVER_ROLE=maintenance-worker SERVER_DUCKDB_OWNER_URL= bun scripts/requestProjectLargeRebuild.ts',
  )
  expect(packageJson.scripts['db:duck:request-review-serving-large-rebuild']).toBe(
    'SERVER_ROLE=maintenance-worker SERVER_DUCKDB_OWNER_URL= bun scripts/requestReviewServingLargeRebuild.ts',
  )
  expect(packageJson.scripts['db:duck:run-large-rebuild-worker-once']).toBeUndefined()
  expect(packageJson.scripts['db:duck:run-large-rebuild-worker-cycles']).toBeUndefined()
  expect(packageJson.scripts['db:duck:legacy-admin-run-large-rebuild-worker-once']).toBe(
    'SERVER_ROLE=maintenance-worker SERVER_DUCKDB_OWNER_URL= bun scripts/runLargeRebuildWorkerOnce.ts --legacy-admin-ack=legacy-large-rebuild',
  )
  expect(packageJson.scripts['db:duck:legacy-admin-run-large-rebuild-worker-cycles']).toBe(
    'SERVER_ROLE=maintenance-worker SERVER_DUCKDB_OWNER_URL= bun scripts/runLargeRebuildWorkerCycles.ts --legacy-admin-ack=legacy-large-rebuild',
  )
  expect(packageJson.scripts['db:duck:quarantine-dirty-refresh-article']).toBe(
    'SERVER_ROLE=maintenance-worker SERVER_DUCKDB_OWNER_URL= bun scripts/quarantineDirtyRefreshArticle.ts',
  )
  expect(packageJson.scripts['db:duck:unquarantine-dirty-refresh-article']).toBe(
    'SERVER_ROLE=maintenance-worker SERVER_DUCKDB_OWNER_URL= bun scripts/unquarantineDirtyRefreshArticle.ts',
  )
  expect(packageJson.scripts['db:duck:inspect-dirty-refresh-risk']).toBe(
    'SERVER_ROLE=maintenance-worker SERVER_DUCKDB_OWNER_URL= bun scripts/inspectDirtyRefreshRisk.ts',
  )
  expect(packageJson.scripts['db:duck:recover-dirty-refresh-claims']).toBe(
    'SERVER_ROLE=maintenance-worker SERVER_DUCKDB_OWNER_URL= bun scripts/recoverDirtyRefreshClaims.ts',
  )
  expect(packageJson.scripts['db:duck:request-judgment-fact-repair']).toBe(
    'SERVER_ROLE=maintenance-worker SERVER_DUCKDB_OWNER_URL= bun scripts/requestJudgmentFactRepair.ts',
  )
  expect(packageJson.scripts['db:duck:run-archived-project-bounded-cleanup']).toBe(
    'SERVER_ROLE=maintenance-worker SERVER_DUCKDB_OWNER_URL= bun scripts/runArchivedProjectBoundedCleanup.ts',
  )
  expect(obsoleteCommandMatches).toEqual([])
})
