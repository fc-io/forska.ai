import {join} from 'node:path'

import {expect, test} from 'bun:test'

const projectRoot = process.cwd()

const readText = async (path: string) => {
  return globalThis.Bun.file(join(projectRoot, path)).text()
}

test('Phase 5B startup stays cut over to V4 projector work', async () => {
  const source = await readText('src/server/utils/startBackgroundWork.ts')

  expect(source).toContain('startReviewServingProjectorWorkerHeartbeat')
  expect(source).not.toContain('startProjectMartRefreshWorkerHeartbeat')
  expect(source).not.toContain('startProjectMartLargeRebuildHeartbeat')
  expect(source).not.toContain('shouldCurrentRuntimeRunMartRefreshDrain')
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

test('Phase 5B legacy worker scripts require explicit admin acknowledgements', async () => {
  const dirtyWorkerScripts = [
    'scripts/runProjectMartRefreshWorker.ts',
    'scripts/runProjectMartRefreshWorkerOnce.ts',
    'scripts/runProjectMartRefreshWorkerOnceIsolated.ts',
  ]
  const largeRebuildScripts = ['scripts/runLargeRebuildWorkerOnce.ts', 'scripts/runLargeRebuildWorkerCycles.ts']

  const dirtyWorkerMissingAck = (
    await Promise.all(
      dirtyWorkerScripts.map(async (path) => {
        const source = await readText(path)

        return source.includes('requireLegacyAdminAck') && source.includes('legacyDirtyRefreshAckValue') ? [] : [path]
      }),
    )
  ).flat()
  const largeRebuildMissingAck = (
    await Promise.all(
      largeRebuildScripts.map(async (path) => {
        const source = await readText(path)

        return source.includes('requireLegacyAdminAck') && source.includes('legacyLargeRebuildAckValue') ? [] : [path]
      }),
    )
  ).flat()

  expect(dirtyWorkerMissingAck).toEqual([])
  expect(largeRebuildMissingAck).toEqual([])
})

test('Phase 5B package commands do not expose normal legacy rebuild workers', async () => {
  const packageJson = (await globalThis.Bun.file(join(projectRoot, 'package.json')).json()) as {
    scripts: Record<string, string>
  }

  expect(packageJson.scripts['db:duck:run-large-rebuild-worker-once']).toBeUndefined()
  expect(packageJson.scripts['db:duck:run-large-rebuild-worker-cycles']).toBeUndefined()
  expect(
    Object.values(packageJson.scripts).some((command) => {
      return command.includes('runProjectMartRefreshWorker')
    }),
  ).toBe(false)
  expect(packageJson.scripts['db:duck:legacy-admin-run-large-rebuild-worker-once']).toContain(
    '--legacy-admin-ack=legacy-large-rebuild',
  )
  expect(packageJson.scripts['db:duck:legacy-admin-run-large-rebuild-worker-cycles']).toContain(
    '--legacy-admin-ack=legacy-large-rebuild',
  )
})
