import {existsSync} from 'node:fs'
import {join} from 'node:path'

import {expect, test} from 'bun:test'

const projectRoot = process.cwd()

const readText = async (path: string) => {
  return globalThis.Bun.file(join(projectRoot, path)).text()
}

test('Phase 5B startup stays cut over to V4 projector work', async () => {
  const source = await readText('src/server/utils/startBackgroundWork.ts')
  const retiredHeartbeatFiles = [
    'src/server/utils/projectMartRefreshWorkerHeartbeat.ts',
    'src/server/utils/projectMartLargeRebuildHeartbeat.ts',
    'src/server/workers/projectMartRefreshWorker.ts',
  ]

  expect(source).toContain('startReviewServingProjectorWorkerHeartbeat')
  expect(source).not.toContain('startProjectMartRefreshWorkerHeartbeat')
  expect(source).not.toContain('startProjectMartLargeRebuildHeartbeat')
  expect(source).not.toContain('shouldCurrentRuntimeRunMartRefreshDrain')
  expect(
    retiredHeartbeatFiles.filter((path) => {
      return existsSync(join(projectRoot, path))
    }),
  ).toEqual([])
})

test('Phase 5B warning and recovery reads stay side-effect free for legacy rebuild paths', async () => {
  const warningsSource = await readText('src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.ts')
  const recoverySource = await readText('scripts/recoverDirtyRefreshClaims.ts')

  expect(warningsSource).not.toContain('mart.judgment_fact')
  expect(warningsSource).not.toContain('missingVisibleJudgmentFacts')
  expect(warningsSource).not.toContain('requestProjectLargeRebuildIfNoLargeRebuild')
  expect(recoverySource).toContain('requestReviewServingV4Rebuilds')
  expect(recoverySource).not.toContain('runProjectMartRefreshWorkerOnce.ts')
  expect(recoverySource).not.toContain('runProjectMartRefreshWorkerOnceIsolated.ts')
  expect(recoverySource).not.toContain('runLargeRebuildWorkerOnce.ts')
})

test('review warnings product route stays separated from legacy mart diagnostics', async () => {
  const warningsSource = await readText('src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.ts')
  const forbiddenMarkers = [
    'getDuckdbMartMaintenanceService',
    'getProjectMartDirtyRefreshStateService',
    'getProjectMartLargeRebuildScopeProgress',
    'getProjectMartLargeRebuildRuntimeMetrics',
    'getDuckdbOwnerConnectionsOverview',
    'getMaintenanceWorkLeaseService',
    'app.project_mart_refresh_state',
    'app.project_mart_dirty_materialization_state',
    'app.project_mart_refresh_article_state',
    'app.project_mart_large_rebuild_state',
  ]

  const presentMarkers = forbiddenMarkers.filter((marker) => {
    return warningsSource.includes(marker)
  })

  expect(presentMarkers).toEqual([])
})

test('Phase 5B legacy worker scripts require explicit admin acknowledgements or deletion', async () => {
  const dirtyWorkerScripts = [
    'scripts/runProjectMartRefreshWorker.ts',
    'scripts/runProjectMartRefreshWorkerOnce.ts',
    'scripts/runProjectMartRefreshWorkerOnceIsolated.ts',
  ]
  const largeRebuildScripts = ['scripts/runLargeRebuildWorkerOnce.ts', 'scripts/runLargeRebuildWorkerCycles.ts']
  const existingLargeRebuildScripts = largeRebuildScripts.filter((path) => {
    return existsSync(join(projectRoot, path))
  })
  const existingDirtyWorkerScripts = dirtyWorkerScripts.filter((path) => {
    return existsSync(join(projectRoot, path))
  })

  const dirtyWorkerMissingAck = (
    await Promise.all(
      existingDirtyWorkerScripts.map(async (path) => {
        const source = await readText(path)

        return source.includes('requireLegacyAdminAck') && source.includes('legacyDirtyRefreshAckValue') ? [] : [path]
      }),
    )
  ).flat()

  expect(dirtyWorkerMissingAck).toEqual([])
  expect(existingLargeRebuildScripts).toEqual([])
})

test('Phase 5B package commands do not expose normal legacy rebuild workers', async () => {
  const packageJson = (await globalThis.Bun.file(join(projectRoot, 'package.json')).json()) as {
    scripts: Record<string, string>
  }

  expect(packageJson.scripts['db:duck:run-large-rebuild-worker-once']).toBeUndefined()
  expect(packageJson.scripts['db:duck:run-large-rebuild-worker-cycles']).toBeUndefined()
  expect(packageJson.scripts['db:duck:legacy-admin-run-large-rebuild-worker-once']).toBeUndefined()
  expect(packageJson.scripts['db:duck:legacy-admin-run-large-rebuild-worker-cycles']).toBeUndefined()
  expect(
    Object.values(packageJson.scripts).some((command) => {
      return command.includes('runProjectMartRefreshWorker')
    }),
  ).toBe(false)
  expect(
    Object.values(packageJson.scripts).some((command) => {
      return command.includes('runLargeRebuildWorker')
    }),
  ).toBe(false)
})

test('admin legacy mart mutation routes stay retired or removed', async () => {
  const adminSource = await readText('src/server/routes/AdminInvestigateRoutes.ts')
  const routeInventorySource = await readText('src/server/routes/routeSurfaceInventory.ts')
  const navigationSource = await readText('src/components/Navigation.tsx')
  const settingsSource = await readText('src/app/routes/+settings/+index.tsx')

  expect(adminSource).not.toContain('getProjectMartDirtyMaterializationService')
  expect(adminSource).not.toContain('requeueDirtyMaterialization')
  expect(adminSource).not.toContain('getProjectMartLargeRebuildHeartbeatConfig')
  expect(adminSource).toContain('getRetiredProjectMartLargeRebuildMutationResponse')
  expect(adminSource).toContain('getRetiredProjectMartDirtyMaterializationMutationResponse')
  expect(routeInventorySource).toContain('retired legacy rebuild/materialization controls')
  expect(navigationSource).not.toContain('/admin/project-mart-large-rebuild')
  expect(settingsSource).not.toContain('projectMartLargeRebuildHeartbeat')
  expect(settingsSource).not.toContain('Maintenance rebuild tuning')
  expect(settingsSource).not.toContain('Heartbeat tuning changes apply')
})
