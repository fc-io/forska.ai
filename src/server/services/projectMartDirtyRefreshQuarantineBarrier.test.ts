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

const getQuarantineBarrierScript = (body: string) => {
  return `
    const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
    const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')

    await migrateDuckdb()

    const database = getAppDatabaseService()

    await database.run(\`
      INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
      VALUES ('quarantine-barrier-connection', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
    \`)
    await database.run(\`
      INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
      VALUES ('quarantine-barrier-model', 'quarantine-barrier-connection', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
    \`)
    await database.run(\`
      INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
      VALUES ('quarantine-barrier-project', 'Quarantine Barrier Project', 'quarantine-barrier-model', TRUE, TRUE, FALSE, FALSE)
    \`)
    await database.run(\`
      INSERT INTO app.article (id, article_title)
      VALUES
        ('quarantine-barrier-article-1', 'Quarantine Barrier Article 1'),
        ('quarantine-barrier-article-2', 'Quarantine Barrier Article 2')
    \`)

    ${body}
  `
}

const runQuarantineBarrierScript = <T>(body: string) => {
  const duckdbPath = `/tmp/f1-project-mart-refresh-quarantine-barrier-${Date.now()}-${Math.random().toString(16).slice(2)}.duckdb`
  const runScript = globalThis.Bun.spawnSync(['bun', '-e', getQuarantineBarrierScript(body)], {
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
    if (runScript.exitCode !== 0) {
      throw new Error(runScript.stderr.toString() || runScript.stdout.toString() || 'Quarantine barrier test failed')
    }

    return JSON.parse(getLastJsonLine(runScript.stdout.toString())) as T
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
    removeFileIfExists(`${duckdbPath}.tmp`)
    removeFileIfExists(`${duckdbPath}.tmp/`)
    removeFileIfExists('/tmp/duckdb-temp')
  }
}

test('quarantine barriers park processed claims and unblock after token-scoped resolution', () => {
  const result = runQuarantineBarrierScript<{
    batchAfterResolve: {articleIds: string[]; hasMore: boolean}
    cleanupAfterCompletion: number
    cleanupBeforeCompletion: number
    claimAfterRedirty: Array<{claimedToken: number; lastCompletedToken: number; projectId: string}>
    claimAfterResolve: Array<{claimedToken: number; lastCompletedToken: number; projectId: string}>
    claimWithoutRedirty: Array<{projectId: string}>
    completionAfterRedirty: {completedState: unknown; isBlockedByQuarantine: boolean; isClaimComplete: boolean}
    completionAfterResolve: {completedState: {lastCompletedDirtyToken: number} | null; isClaimComplete: boolean}
    completionAtBarrier: {completedState: unknown; isBlockedByQuarantine: boolean; isClaimComplete: boolean}
    parkedAfterRedirty: {
      activeDirtyToken: number
      dirtyToken: number
      lastCompletedDirtyToken: number
      refreshStatus: string
      workerId: string | null
    }
    parkedAtBarrier: {
      activeDirtyToken: number
      dirtyToken: number
      lastCompletedDirtyToken: number
      refreshStatus: string
      workerId: string | null
    }
    quarantineRowsAfterCleanup: Array<{articleId: string; dirtyToken: number; projectId: string}>
    unresolvedQuarantineRows: Array<{
      articleId: string
      dirtyToken: number
      projectId: string
      resolvedAt: string | null
    }>
  }>(`
    const {getProjectMartDirtyRefreshStateService} = await import('./src/server/services/projectMartDirtyRefreshStateService.ts')
    const service = getProjectMartDirtyRefreshStateService()

    await service.markProjectsDirtyAtomically({
      projects: [{
        articleIds: ['quarantine-barrier-article-1', 'quarantine-barrier-article-2'],
        projectId: 'quarantine-barrier-project',
      }],
      reason: 'quarantine-barrier.initial',
      now: new Date('2026-05-03T08:00:00.000Z'),
    })
    const [firstClaim] = await service.claimDirtyProjects({
      leaseMs: 5000,
      limit: 1,
      now: new Date('2026-05-03T08:00:01.000Z'),
      workerId: 'quarantine-barrier-worker-1',
    })
    await service.quarantineProjectRefreshArticle({
      articleId: 'quarantine-barrier-article-1',
      detectedBy: 'test-suite',
      error: 'native crash repro',
      now: new Date('2026-05-03T08:00:02.000Z'),
      projectId: 'quarantine-barrier-project',
    })
    const firstBatch = await service.getDirtyArticleBatchForClaim({
      batchSize: 10,
      claimedToken: firstClaim.claimedToken,
      projectId: firstClaim.projectId,
      workerId: firstClaim.workerId,
    })
    const completionAtBarrier = await service.completeDirtyArticleBatchForClaim({
      articleIds: firstBatch.articleIds,
      claimedToken: firstClaim.claimedToken,
      now: new Date('2026-05-03T08:00:03.000Z'),
      projectId: firstClaim.projectId,
      workerId: firstClaim.workerId,
    })
    const [parkedAtBarrier] = await database.queryJson(\`
      SELECT
        CAST(active_dirty_token AS INTEGER) AS activeDirtyToken,
        CAST(dirty_token AS INTEGER) AS dirtyToken,
        CAST(last_completed_dirty_token AS INTEGER) AS lastCompletedDirtyToken,
        refresh_status AS refreshStatus,
        worker_id AS workerId
      FROM app.project_mart_refresh_state
      WHERE project_id = 'quarantine-barrier-project'
      LIMIT 1
    \`)
    const claimWithoutRedirty = await service.claimDirtyProjects({
      leaseMs: 5000,
      limit: 1,
      now: new Date('2026-05-03T08:00:04.000Z'),
      workerId: 'quarantine-barrier-worker-2',
    })

    await service.markProjectsDirtyAtomically({
      projects: [{articleIds: ['quarantine-barrier-article-2'], projectId: 'quarantine-barrier-project'}],
      reason: 'quarantine-barrier.redirty',
      now: new Date('2026-05-03T08:00:05.000Z'),
    })
    const claimAfterRedirty = await service.claimDirtyProjects({
      leaseMs: 5000,
      limit: 1,
      now: new Date('2026-05-03T08:00:06.000Z'),
      workerId: 'quarantine-barrier-worker-3',
    })
    const [secondClaim] = claimAfterRedirty
    const secondBatch = await service.getDirtyArticleBatchForClaim({
      batchSize: 10,
      claimedToken: secondClaim.claimedToken,
      projectId: secondClaim.projectId,
      workerId: secondClaim.workerId,
    })
    const completionAfterRedirty = await service.completeDirtyArticleBatchForClaim({
      articleIds: secondBatch.articleIds,
      claimedToken: secondClaim.claimedToken,
      now: new Date('2026-05-03T08:00:07.000Z'),
      projectId: secondClaim.projectId,
      workerId: secondClaim.workerId,
    })
    const [parkedAfterRedirty] = await database.queryJson(\`
      SELECT
        CAST(active_dirty_token AS INTEGER) AS activeDirtyToken,
        CAST(dirty_token AS INTEGER) AS dirtyToken,
        CAST(last_completed_dirty_token AS INTEGER) AS lastCompletedDirtyToken,
        refresh_status AS refreshStatus,
        worker_id AS workerId
      FROM app.project_mart_refresh_state
      WHERE project_id = 'quarantine-barrier-project'
      LIMIT 1
    \`)
    const unresolvedQuarantineRows = await database.queryJson(\`
      SELECT
        project_id AS projectId,
        article_id AS articleId,
        CAST(dirty_token AS INTEGER) AS dirtyToken,
        resolved_at AS resolvedAt
      FROM app.project_mart_dirty_refresh_article_quarantine
      WHERE project_id = 'quarantine-barrier-project'
      ORDER BY dirty_token ASC, article_id ASC
    \`)

    await service.resolveProjectRefreshArticleQuarantine({
      articleId: 'quarantine-barrier-article-1',
      dirtyToken: 1,
      now: new Date('2026-05-03T08:00:08.000Z'),
      projectId: 'quarantine-barrier-project',
    })
    const cleanupBeforeCompletion = await service.cleanupResolvedProjectRefreshArticleQuarantines({limit: 10})
    const claimAfterResolve = await service.claimDirtyProjects({
      leaseMs: 5000,
      limit: 1,
      now: new Date('2026-05-03T08:00:09.000Z'),
      workerId: 'quarantine-barrier-worker-4',
    })
    const [thirdClaim] = claimAfterResolve
    const batchAfterResolve = await service.getDirtyArticleBatchForClaim({
      batchSize: 10,
      claimedToken: thirdClaim.claimedToken,
      projectId: thirdClaim.projectId,
      workerId: thirdClaim.workerId,
    })
    const completionAfterResolve = await service.completeDirtyArticleBatchForClaim({
      articleIds: batchAfterResolve.articleIds,
      claimedToken: thirdClaim.claimedToken,
      now: new Date('2026-05-03T08:00:10.000Z'),
      projectId: thirdClaim.projectId,
      workerId: thirdClaim.workerId,
    })
    const cleanupAfterCompletion = await service.cleanupResolvedProjectRefreshArticleQuarantines({limit: 10})
    const quarantineRowsAfterCleanup = await database.queryJson(\`
      SELECT
        project_id AS projectId,
        article_id AS articleId,
        CAST(dirty_token AS INTEGER) AS dirtyToken
      FROM app.project_mart_dirty_refresh_article_quarantine
      WHERE project_id = 'quarantine-barrier-project'
      ORDER BY dirty_token ASC, article_id ASC
    \`)

    console.log(JSON.stringify({
      batchAfterResolve,
      cleanupAfterCompletion,
      cleanupBeforeCompletion,
      claimAfterRedirty,
      claimAfterResolve,
      claimWithoutRedirty,
      completionAfterRedirty,
      completionAfterResolve,
      completionAtBarrier,
      parkedAfterRedirty,
      parkedAtBarrier,
      quarantineRowsAfterCleanup,
      unresolvedQuarantineRows,
    }))
    await database.close()
  `)

  expect(result.completionAtBarrier).toMatchObject({
    completedState: null,
    isBlockedByQuarantine: true,
    isClaimComplete: false,
  })
  expect(result.parkedAtBarrier).toEqual({
    activeDirtyToken: 1,
    dirtyToken: 1,
    lastCompletedDirtyToken: 0,
    refreshStatus: 'blocked_by_quarantine',
    workerId: null,
  })
  expect(result.claimWithoutRedirty).toEqual([])
  expect(result.claimAfterRedirty).toMatchObject([
    {claimedToken: 2, lastCompletedToken: 0, projectId: 'quarantine-barrier-project'},
  ])
  expect(result.completionAfterRedirty).toMatchObject({
    completedState: null,
    isBlockedByQuarantine: true,
    isClaimComplete: false,
  })
  expect(result.parkedAfterRedirty).toEqual({
    activeDirtyToken: 2,
    dirtyToken: 2,
    lastCompletedDirtyToken: 0,
    refreshStatus: 'blocked_by_quarantine',
    workerId: null,
  })
  expect(result.unresolvedQuarantineRows).toEqual([
    {
      articleId: 'quarantine-barrier-article-1',
      dirtyToken: 1,
      projectId: 'quarantine-barrier-project',
      resolvedAt: null,
    },
  ])
  expect(result.cleanupBeforeCompletion).toBe(0)
  expect(result.claimAfterResolve).toMatchObject([
    {claimedToken: 2, lastCompletedToken: 0, projectId: 'quarantine-barrier-project'},
  ])
  expect(result.batchAfterResolve).toEqual({articleIds: ['quarantine-barrier-article-1'], hasMore: false})
  expect(result.completionAfterResolve.isClaimComplete).toBe(true)
  expect(result.completionAfterResolve.completedState?.lastCompletedDirtyToken).toBe(2)
  expect(result.cleanupAfterCompletion).toBe(1)
  expect(result.quarantineRowsAfterCleanup).toEqual([])
})
