import {rmSync} from 'node:fs'

import {expect, test} from 'bun:test'

const removeFileIfExists = (filePath: string) => {
  rmSync(filePath, {force: true, recursive: true})
}

const getLastJsonLine = (stdout: string) => {
  const lines = stdout
    .split('\n')
    .map((line) => {
      return line.trim()
    })
    .filter((line) => {
      return line !== ''
    })

  return lines.at(-1) ?? ''
}

const getScript = (body: string) => {
  return `
    const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
    const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
    const {getProjectMartDirtyRefreshStateService} = await import('./src/server/services/projectMartDirtyRefreshStateService.ts')
    const {getProjectMartLargeRebuildStateService} = await import('./src/server/services/projectMartLargeRebuildStateService.ts')

    await migrateDuckdb()

    const database = getAppDatabaseService()
    const dirtyService = getProjectMartDirtyRefreshStateService()
    const largeRebuildService = getProjectMartLargeRebuildStateService()

    await database.run(\`
      INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
      VALUES ('large-rebuild-frozen-connection', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
    \`)
    await database.run(\`
      INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
      VALUES ('large-rebuild-frozen-model', 'large-rebuild-frozen-connection', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
    \`)
    await database.run(\`
      INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
      VALUES ('large-rebuild-frozen-project', 'Large Rebuild Frozen Project', 'large-rebuild-frozen-model', TRUE, TRUE, FALSE, FALSE)
    \`)
    await database.run(\`
      INSERT INTO app.article (id, article_title, article_created_at, article_updated_at)
      VALUES
        ('large-rebuild-frozen-article-1', 'Article 1', TIMESTAMPTZ '2026-04-01T00:00:00.000Z', TIMESTAMPTZ '2026-04-01T01:00:00.000Z'),
        ('large-rebuild-frozen-article-2', 'Article 2', TIMESTAMPTZ '2026-04-02T00:00:00.000Z', TIMESTAMPTZ '2026-04-02T01:00:00.000Z')
    \`)

    ${body}
  `
}

const runScript = <T>(body: string) => {
  const duckdbPath = `/tmp/f1-project-mart-large-rebuild-frozen-${Date.now()}-${Math.random().toString(16).slice(2)}.duckdb`
  const runResult = globalThis.Bun.spawnSync(['bun', '-e', getScript(body)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      API_SERVER_PORT: '3001',
      DUCKDB_PATH: duckdbPath,
      SERVER_ROLE: 'dev-single',
      VITE_PORT: '3000',
    },
  })

  try {
    if (runResult.exitCode !== 0) {
      throw new Error(runResult.stderr.toString() || runResult.stdout.toString() || 'Frozen scope test failed')
    }

    return JSON.parse(getLastJsonLine(runResult.stdout.toString())) as T
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
    removeFileIfExists('/tmp/duckdb-temp')
  }
}

test('frozen scope records source dirty token and leaves later dirty work pending', () => {
  const result = runScript<{
    finalizedState: {dirtyToken: number; lastCompletedDirtyToken: number; refreshStatus: string} | null
    remainingArticleRows: Array<{articleId: string; firstDirtyToken: number; lastDirtyToken: number}>
    rebuildState: {sourceDirtyToken: number | null; sourceHighWaterDirtyToken: number | null} | null
  }>(`
    await dirtyService.markProjectsDirtyAtomically({
      now: new Date('2026-04-03T08:00:00.000Z'),
      projects: [{articleIds: ['large-rebuild-frozen-article-1'], projectId: 'large-rebuild-frozen-project'}],
      reason: 'large-rebuild-frozen.initial',
    })
    await largeRebuildService.requestLargeRebuild({
      projectId: 'large-rebuild-frozen-project',
      rebuildPhase: 'project_scope_article',
      refreshToken: 1,
    })

    const [claim] = await largeRebuildService.claimLargeRebuilds({
      leaseMs: 5000,
      limit: 1,
      now: new Date('2026-04-03T08:00:01.000Z'),
      workerId: 'worker-frozen',
    })
    await largeRebuildService.recordLargeRebuildFrozenScope({
      expectedRebuildPhase: claim.rebuildPhase,
      expectedRefreshToken: claim.refreshToken,
      expectedTargetGeneration: claim.targetGeneration ?? null,
      now: new Date('2026-04-03T08:00:02.000Z'),
      projectId: claim.projectId,
      workerId: claim.workerId,
    })
    await dirtyService.markProjectsDirtyAtomically({
      now: new Date('2026-04-03T08:00:03.000Z'),
      projects: [{articleIds: ['large-rebuild-frozen-article-2'], projectId: 'large-rebuild-frozen-project'}],
      reason: 'large-rebuild-frozen.later',
    })

    const rebuildState = await largeRebuildService.getLargeRebuildState('large-rebuild-frozen-project')
    const finalizedState = await dirtyService.finalizeProjectRefreshAfterLargeRebuild({
      completedToken: rebuildState.sourceHighWaterDirtyToken,
      now: new Date('2026-04-03T08:00:04.000Z'),
      projectId: 'large-rebuild-frozen-project',
    })
    const remainingArticleRows = await database.queryJson(\`
      SELECT
        article_id AS articleId,
        CAST(first_dirty_token AS INTEGER) AS firstDirtyToken,
        CAST(last_dirty_token AS INTEGER) AS lastDirtyToken
      FROM app.project_mart_refresh_article_state
      WHERE project_id = 'large-rebuild-frozen-project'
        AND last_dirty_token > 0
      ORDER BY article_id ASC
    \`)

    console.log(JSON.stringify({finalizedState, remainingArticleRows, rebuildState}))
    await database.close()
  `)

  expect(result.rebuildState?.sourceDirtyToken).toBe(1)
  expect(result.rebuildState?.sourceHighWaterDirtyToken).toBe(1)
  expect(result.finalizedState?.dirtyToken).toBe(2)
  expect(result.finalizedState?.lastCompletedDirtyToken).toBe(1)
  expect(result.finalizedState?.refreshStatus).toBe('idle')
  expect(result.remainingArticleRows).toEqual([
    {articleId: 'large-rebuild-frozen-article-2', firstDirtyToken: 2, lastDirtyToken: 2},
  ])
})
