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
    const {getProjectMartLargeRebuildExecutor} = await import('./src/server/services/projectMartLargeRebuildExecutor.ts')
    const {getProjectMartLargeRebuildStateService} = await import('./src/server/services/projectMartLargeRebuildStateService.ts')

    await migrateDuckdb()

    const database = getAppDatabaseService()
    const executor = getProjectMartLargeRebuildExecutor()
    const stateService = getProjectMartLargeRebuildStateService()

    await database.run(\`
      INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
      VALUES ('large-rebuild-fence-connection', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
    \`)
    await database.run(\`
      INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
      VALUES ('large-rebuild-fence-model', 'large-rebuild-fence-connection', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
    \`)
    await database.run(\`
      INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
      VALUES ('large-rebuild-fence-project', 'Large Rebuild Fence Project', 'large-rebuild-fence-model', TRUE, TRUE, FALSE, FALSE)
    \`)
    await database.run(\`
      INSERT INTO app.article (id, article_title, article_created_at, article_updated_at)
      VALUES ('large-rebuild-fence-article-1', 'Article 1', TIMESTAMPTZ '2026-04-01T00:00:00.000Z', TIMESTAMPTZ '2026-04-01T01:00:00.000Z')
    \`)
    await database.run(\`
      INSERT INTO app.prompt (id, original_text, content_hash)
      VALUES ('large-rebuild-fence-prompt', 'Fence prompt', 'large-rebuild-fence-prompt-hash')
    \`)

    ${body}
  `
}

const runScript = <T>(body: string) => {
  const duckdbPath = `/tmp/f1-project-mart-large-rebuild-fencing-${Date.now()}-${Math.random().toString(16).slice(2)}.duckdb`
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
      throw new Error(runResult.stderr.toString() || runResult.stdout.toString() || 'Lease fencing test failed')
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

test('stale large rebuild lease cannot promote or complete after claim transfer', () => {
  const result = runScript<{
    activeGeneration: number
    currentCompleted: {projectId: string} | null
    currentPromoted: boolean
    staleCompleted: {projectId: string} | null
    staleHeartbeat: {projectId: string} | null
    stalePromoted: boolean
    staleReset: {projectId: string} | null
  }>(`
    await stateService.requestLargeRebuild({
      projectId: 'large-rebuild-fence-project',
      rebuildPhase: 'review_article_serving',
      refreshToken: 7,
      targetGeneration: 2,
    })
    const [firstClaim] = await stateService.claimLargeRebuilds({
      leaseMs: 1000,
      limit: 1,
      now: new Date('2026-04-03T08:00:00.000Z'),
      workerId: 'worker-stale',
    })
    const [secondClaim] = await stateService.claimLargeRebuilds({
      leaseMs: 5000,
      limit: 1,
      now: new Date('2026-04-03T08:00:02.000Z'),
      workerId: 'worker-current',
    })

    await database.run(\`
      INSERT INTO app.project_review_serving_generation (project_id, active_generation)
      VALUES ('large-rebuild-fence-project', 1)
    \`)
    await database.run(\`
      INSERT INTO mart.review_article_serving (
        project_id, generation, article_id, article_created_at, article_updated_at, article_title,
        has_all_llm_judgments, llm_judged_prompt_count, enabled_prompt_count, human_answered_prompt_count,
        has_all_human_answers, review_opened, review_sections_completed
      ) VALUES (
        'large-rebuild-fence-project', 2, 'large-rebuild-fence-article-1',
        TIMESTAMPTZ '2026-04-01T00:00:00.000Z', TIMESTAMPTZ '2026-04-01T01:00:00.000Z',
        'Article 1', TRUE, 1, 1, 0, FALSE, FALSE, 0
      )
    \`)

    const staleHeartbeat = await stateService.heartbeatLargeRebuildClaim({
      expectedRebuildPhase: firstClaim.rebuildPhase,
      expectedRefreshToken: firstClaim.refreshToken,
      expectedTargetGeneration: firstClaim.targetGeneration,
      leaseMs: 5000,
      now: new Date('2026-04-03T08:00:03.000Z'),
      projectId: firstClaim.projectId,
      workerId: firstClaim.workerId,
    })
    const staleReset = await stateService.resetLargeRebuild({
      expectedRebuildPhase: firstClaim.rebuildPhase,
      expectedRefreshToken: firstClaim.refreshToken,
      expectedTargetGeneration: firstClaim.targetGeneration,
      now: new Date('2026-04-03T08:00:03.000Z'),
      projectId: firstClaim.projectId,
      rebuildPhase: 'review_article_serving',
      targetGeneration: firstClaim.targetGeneration,
      workerId: firstClaim.workerId,
    })
    const stalePromoted = await executor.finalizeProjectReviewServing('large-rebuild-fence-project', 2, {
      expectedRebuildPhase: firstClaim.rebuildPhase,
      expectedRefreshToken: firstClaim.refreshToken,
      expectedTargetGeneration: firstClaim.targetGeneration,
      now: new Date('2026-04-03T08:00:03.000Z'),
      workerId: firstClaim.workerId,
    })
    const currentPromoted = await executor.finalizeProjectReviewServing('large-rebuild-fence-project', 2, {
      expectedRebuildPhase: secondClaim.rebuildPhase,
      expectedRefreshToken: secondClaim.refreshToken,
      expectedTargetGeneration: secondClaim.targetGeneration,
      now: new Date('2026-04-03T08:00:03.000Z'),
      workerId: secondClaim.workerId,
    })
    const staleCompleted = await stateService.completeLargeRebuild({
      expectedRebuildPhase: firstClaim.rebuildPhase,
      expectedRefreshToken: firstClaim.refreshToken,
      expectedTargetGeneration: firstClaim.targetGeneration,
      now: new Date('2026-04-03T08:00:04.000Z'),
      projectId: firstClaim.projectId,
      workerId: firstClaim.workerId,
    })
    const currentCompleted = await stateService.completeLargeRebuild({
      expectedRebuildPhase: secondClaim.rebuildPhase,
      expectedRefreshToken: secondClaim.refreshToken,
      expectedTargetGeneration: secondClaim.targetGeneration,
      now: new Date('2026-04-03T08:00:04.000Z'),
      projectId: secondClaim.projectId,
      workerId: secondClaim.workerId,
    })
    const [generation] = await database.queryJson(\`
      SELECT CAST(active_generation AS INTEGER) AS activeGeneration
      FROM app.project_review_serving_generation
      WHERE project_id = 'large-rebuild-fence-project'
    \`)

    console.log(JSON.stringify({
      activeGeneration: generation.activeGeneration,
      currentCompleted,
      currentPromoted,
      staleCompleted,
      staleHeartbeat,
      stalePromoted,
      staleReset,
    }))
    await database.close()
  `)

  expect(result.staleHeartbeat).toBeNull()
  expect(result.staleReset).toBeNull()
  expect(result.stalePromoted).toBe(false)
  expect(result.staleCompleted).toBeNull()
  expect(result.currentPromoted).toBe(true)
  expect(result.currentCompleted?.projectId).toBe('large-rebuild-fence-project')
  expect(result.activeGeneration).toBe(2)
})

test('old generation cleanup skips target generation and deletes only leased generation batches', () => {
  const result = runScript<{
    cleanupLeaseRows: Array<{consumerId: string; queueId: string | null}>
    firstCleanup: {deletedRowCount: number}
    remainingRows: Array<{generation: string; rowCount: string; tableName: string}>
    secondCleanup: {deletedRowCount: number}
  }>(`
    await database.run(\`
      INSERT INTO app.project_review_serving_generation (project_id, active_generation)
      VALUES ('large-rebuild-fence-project', 5)
    \`)
    await database.run(\`
      INSERT INTO mart.review_article_serving (
        project_id, generation, article_id, article_created_at, article_updated_at, article_title,
        has_all_llm_judgments, llm_judged_prompt_count, enabled_prompt_count, human_answered_prompt_count,
        has_all_human_answers, review_opened, review_sections_completed
      ) VALUES
        ('large-rebuild-fence-project', 2, 'large-rebuild-fence-article-1', TIMESTAMPTZ '2026-04-01T00:00:00.000Z', TIMESTAMPTZ '2026-04-01T01:00:00.000Z', 'Article 1', TRUE, 1, 1, 0, FALSE, FALSE, 0),
        ('large-rebuild-fence-project', 3, 'large-rebuild-fence-article-1', TIMESTAMPTZ '2026-04-01T00:00:00.000Z', TIMESTAMPTZ '2026-04-01T01:00:00.000Z', 'Article 1', TRUE, 1, 1, 0, FALSE, FALSE, 0)
    \`)
    await database.run(\`
      INSERT INTO mart.review_article_filter_member (project_id, generation, prompt_id, answer_id, article_id)
      VALUES
        ('large-rebuild-fence-project', 2, 'large-rebuild-fence-prompt', 1, 'large-rebuild-fence-article-1'),
        ('large-rebuild-fence-project', 3, 'large-rebuild-fence-prompt', 1, 'large-rebuild-fence-article-1')
    \`)
    await database.run(\`
      INSERT INTO mart.review_article_serving_detail (project_id, generation, article_id, prompt_id, judgment_id, created_at, model_id)
      VALUES
        ('large-rebuild-fence-project', 2, 'large-rebuild-fence-article-1', 'large-rebuild-fence-prompt', 'large-rebuild-fence-judgment-2', TIMESTAMPTZ '2026-04-01T00:00:00.000Z', 'large-rebuild-fence-model'),
        ('large-rebuild-fence-project', 3, 'large-rebuild-fence-article-1', 'large-rebuild-fence-prompt', 'large-rebuild-fence-judgment-3', TIMESTAMPTZ '2026-04-01T00:00:00.000Z', 'large-rebuild-fence-model')
    \`)

    const firstCleanup = await executor.cleanupProjectReviewServingGenerationsBatch({
      batchSize: 10,
      leaseMs: 5000,
      now: new Date('2026-04-03T08:00:00.000Z'),
      projectId: 'large-rebuild-fence-project',
      workerId: 'cleanup-worker',
    })
    await stateService.requestLargeRebuild({
      projectId: 'large-rebuild-fence-project',
      rebuildPhase: 'review_article_serving',
      refreshToken: 8,
      targetGeneration: 3,
    })
    const secondCleanup = await executor.cleanupProjectReviewServingGenerationsBatch({
      batchSize: 10,
      leaseMs: 5000,
      now: new Date('2026-04-03T08:00:01.000Z'),
      projectId: 'large-rebuild-fence-project',
      workerId: 'cleanup-worker',
    })
    const remainingRows = await database.queryJson(\`
      SELECT 'filter_member' AS tableName, CAST(generation AS VARCHAR) AS generation, CAST(COUNT(*) AS VARCHAR) AS rowCount
      FROM mart.review_article_filter_member
      WHERE project_id = 'large-rebuild-fence-project'
      GROUP BY generation
      UNION ALL
      SELECT 'serving' AS tableName, CAST(generation AS VARCHAR) AS generation, CAST(COUNT(*) AS VARCHAR) AS rowCount
      FROM mart.review_article_serving
      WHERE project_id = 'large-rebuild-fence-project'
      GROUP BY generation
      UNION ALL
      SELECT 'serving_detail' AS tableName, CAST(generation AS VARCHAR) AS generation, CAST(COUNT(*) AS VARCHAR) AS rowCount
      FROM mart.review_article_serving_detail
      WHERE project_id = 'large-rebuild-fence-project'
      GROUP BY generation
      ORDER BY tableName ASC, generation ASC
    \`)
    const cleanupLeaseRows = await database.queryJson(\`
      SELECT consumer_id AS consumerId, queue_id AS queueId
      FROM app.maintenance_work_lease
      WHERE work_kind = 'review_index_serving_generation_cleanup'
      ORDER BY queue_id ASC
    \`)

    console.log(JSON.stringify({cleanupLeaseRows, firstCleanup, remainingRows, secondCleanup}))
    await database.close()
  `)

  expect(result.firstCleanup.deletedRowCount).toBe(3)
  expect(result.secondCleanup.deletedRowCount).toBe(0)
  expect(result.remainingRows).toEqual([
    {generation: '3', rowCount: '1', tableName: 'filter_member'},
    {generation: '3', rowCount: '1', tableName: 'serving'},
    {generation: '3', rowCount: '1', tableName: 'serving_detail'},
  ])
  expect(result.cleanupLeaseRows).toEqual([{consumerId: 'cleanup-worker', queueId: 'generation:2'}])
})
