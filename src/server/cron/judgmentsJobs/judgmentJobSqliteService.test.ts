import {existsSync, rmSync, writeFileSync} from 'node:fs'
import {dirname, join} from 'node:path'

import {Database} from 'bun:sqlite'
import {afterAll, beforeAll, expect, test} from 'bun:test'

import {getJudgmentJobLeasePath, getJudgmentJobSqlitePath} from './judgmentJobPaths.ts'

const tempDbPath = `/tmp/f1-judgment-job-sqlite-service-${process.pid}-${Date.now()}.duckdb`
const tempJobDir = join(dirname(tempDbPath), 'judgment-jobs')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempDbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.RUN_SERVER_JUDGING = 'false'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

let closeDatabase: (() => Promise<void>) | null = null
let runDatabase: ((statement: string) => Promise<void>) | null = null
let sqliteService: Awaited<typeof import('./judgmentJobSqliteService.ts')>['getJudgmentJobSqliteService'] | null = null

const waitForPaths = async (paths: string[], timeoutMs: number): Promise<void> => {
  const startedAt = Date.now()

  const check = async (): Promise<void> => {
    if (
      paths.every((path) => {
        return existsSync(path)
      })
    ) {
      return
    }

    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out waiting for ${paths.join(', ')}`)
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 20)
    })

    return check()
  }

  return check()
}

beforeAll(async () => {
  const [
    {migrateDuckdb},
    {getAppDatabaseService},
    {resetDuckdbServiceForTests},
    {resetServerRuntimeRoleForTests},
    sqliteModule,
  ] = await Promise.all([
    import('../../../db/migrateDuckdb.ts'),
    import('../../services/appDatabaseService.ts'),
    import('../../utils/duckdbService.ts'),
    import('../../utils/serverRuntimeRole.ts'),
    import('./judgmentJobSqliteService.ts'),
  ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()

  await migrateDuckdb()

  const database = getAppDatabaseService()

  closeDatabase = () => {
    return database.close()
  }
  runDatabase = (statement: string) => {
    return database.run(statement)
  }
  sqliteService = sqliteModule.getJudgmentJobSqliteService
})

afterAll(async () => {
  await sqliteService?.().closeAll()
  await closeDatabase?.()
  rmSync(tempDbPath, {force: true})
  rmSync(`${tempDbPath}.writer.history.json`, {force: true})
  rmSync(`${tempDbPath}.writer.lock`, {force: true})
  rmSync(tempJobDir, {force: true, recursive: true})
})

test('claims and requeues prompts from the per-job SQLite queue', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-${Date.now()}`
  const modelId = `model-${Date.now()}`
  const projectId = `project-${Date.now()}`
  const jobId = `job-${Date.now()}`

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('${connectionId}', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
  `)
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${projectId}', 'SQLite Queue Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(
    jobId,
    [
      {articleId: 'article-1', promptId: 'prompt-1'},
      {articleId: 'article-1', promptId: 'prompt-1'},
      {articleId: 'article-2', promptId: 'prompt-2'},
    ],
    'server-a',
  )

  expect(await service.getReadyCount(jobId)).toBe(2)

  const claimed = await service.claimReadyPrompts(jobId, 'server-a', 1)

  expect(claimed).toHaveLength(1)
  expect(await service.getReadyCount(jobId)).toBe(1)
  expect(await service.getInFlightCount(jobId)).toBe(1)

  const requeued = await service.requeueAbandonedSentPrompts({
    jobId,
    serverJobId: 'server-b',
    staleBefore: new Date(Date.now() + 1000),
  })

  expect(requeued).toBe(1)
  expect(await service.getReadyCount(jobId)).toBe(2)
  expect(await service.getInFlightCount(jobId)).toBe(0)
})

test('runs isolated SQLite preflight against queue and outbox state', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-preflight-${Date.now()}`
  const modelId = `model-preflight-${Date.now()}`
  const projectId = `project-preflight-${Date.now()}`
  const jobId = `job-preflight-${Date.now()}`

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('${connectionId}', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
  `)
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${projectId}', 'SQLite Preflight Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(jobId, [{articleId: 'article-preflight', promptId: 'prompt-preflight'}], 'server-a')

  const [claimedPrompt] = await service.claimReadyPrompts(jobId, 'server-a', 1)

  if (!claimedPrompt) {
    throw new Error('Expected a claimed prompt for SQLite preflight test')
  }

  await service.recordJudgmentSuccess(jobId, {
    answeredOriginal: 'yes',
    answeredOriginalAsArray: ['yes'],
    articleId: claimedPrompt.articleId,
    chunkingStrategy: null,
    confidenceOriginal: 90,
    createdAt: new Date(),
    explanation: 'preflight',
    isAnswered: true,
    judgmentId: `judgment-preflight-${Date.now()}`,
    modelId,
    projectId,
    promptId: claimedPrompt.promptId,
    queuePromptId: claimedPrompt.recordId,
    quotes: ['quote'],
    rawResponseJson: {answer: 'yes'},
    snapshotProjectId: projectId,
    snapshotProjectModelName: 'Qwen 35B',
    updatedAt: new Date(),
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  })

  const snapshot = await service.runIsolatedPreflight(jobId)

  expect(snapshot.queueSampleCount).toBe(1)
  expect(snapshot.outboxSampleCount).toBe(1)
  expect(snapshot.sqliteFileBytes).toBeGreaterThan(0)
  expect(snapshot.walBytes).toBeGreaterThanOrEqual(0)

  await service.closeAll()
})

test('isolated SQLite preflight fails when required schema is missing', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-preflight-fail-${Date.now()}`
  const modelId = `model-preflight-fail-${Date.now()}`
  const projectId = `project-preflight-fail-${Date.now()}`
  const jobId = `job-preflight-fail-${Date.now()}`
  const sqlitePath = getJudgmentJobSqlitePath(jobId)

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('${connectionId}', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
  `)
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${projectId}', 'SQLite Preflight Failure Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'paused')
  `)

  const malformedDatabase = new Database(sqlitePath, {create: true})
  malformedDatabase.exec(`CREATE TABLE job_info (job_id TEXT PRIMARY KEY, created_at TEXT NOT NULL);`)
  malformedDatabase.close(false)
  const preflightError = await service
    .runIsolatedPreflight(jobId)
    .then(() => {
      return null
    })
    .catch((error: unknown) => {
      return error instanceof Error ? error : new Error(String(error))
    })

  expect(preflightError).toBeInstanceOf(Error)
  expect(preflightError?.message).toContain('SQLite job DB preflight failed')

  await service.closeAll()
  rmSync(sqlitePath, {force: true})
})

test('limits SQLite ready inserts to the requested deficit while skipping duplicates', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-limit-${Date.now()}`
  const modelId = `model-limit-${Date.now()}`
  const projectId = `project-limit-${Date.now()}`
  const jobId = `job-limit-${Date.now()}`

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('${connectionId}', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
  `)
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${projectId}', 'SQLite Queue Limit Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  await service.initializeJob(jobId)

  expect(
    await service.addReadyPrompts(
      jobId,
      [
        {articleId: 'article-limit-1', promptId: 'prompt-limit-1'},
        {articleId: 'article-limit-2', promptId: 'prompt-limit-2'},
        {articleId: 'article-limit-3', promptId: 'prompt-limit-3'},
      ],
      'server-a',
      2,
    ),
  ).toBe(2)
  expect(await service.getReadyCount(jobId)).toBe(2)

  expect(
    await service.addReadyPrompts(
      jobId,
      [
        {articleId: 'article-limit-1', promptId: 'prompt-limit-1'},
        {articleId: 'article-limit-4', promptId: 'prompt-limit-4'},
        {articleId: 'article-limit-5', promptId: 'prompt-limit-5'},
      ],
      'server-a',
      1,
    ),
  ).toBe(1)
  expect(await service.getReadyCount(jobId)).toBe(3)
})

test('getJobInfo refreshes provider runtime settings from the current model connection', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-refresh-${Date.now()}`
  const modelId = `model-refresh-${Date.now()}`
  const projectId = `project-refresh-${Date.now()}`
  const jobId = `job-refresh-${Date.now()}`

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url, config_json)
    VALUES (
      '${connectionId}',
      'sglang',
      'SGLang Refresh',
      TRUE,
      'none',
      'http://127.0.0.1:30000/v1',
      '{"manualWorkerUrls":[],"workerUrlMode":"runtime"}'
    )
  `)
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', 'Qwen/Qwen3.5-27B', 'Qwen/Qwen3.5-27B', 'Qwen 27B', 'manual', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${projectId}', 'SQLite Queue Refresh Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  await service.initializeJob(jobId)
  await runDatabase(`
    UPDATE app.provider_connection
    SET base_url = 'http://127.0.0.1:30001/v1',
        config_json = '{"manualWorkerUrls":["http://127.0.0.1:30001"],"workerUrlMode":"runtime"}'
    WHERE id = '${connectionId}'
  `)

  const jobInfo = await service.getJobInfo(jobId)

  expect(jobInfo?.modelBaseUrl).toBe('http://127.0.0.1:30001/v1')
  expect(jobInfo?.providerConfigJson).toEqual({manualWorkerUrls: ['http://127.0.0.1:30001'], workerUrlMode: 'runtime'})
})

test('claims each SQLite prompt pair at most once under competing writers', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-contention-${Date.now()}`
  const modelId = `model-contention-${Date.now()}`
  const projectId = `project-contention-${Date.now()}`
  const jobId = `job-contention-${Date.now()}`
  const workerCount = 4
  const promptPairs = Array.from({length: 12}, (_value, index) => {
    return {articleId: `article-contention-${index + 1}`, promptId: `prompt-contention-${index + 1}`}
  })
  const syncDir = join(dirname(tempDbPath), `judgment-job-sqlite-contention-${jobId}`)
  const startPath = join(syncDir, 'start')
  const readyPaths = Array.from({length: workerCount}, (_value, index) => {
    return join(syncDir, `worker-${index}.ready`)
  })

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('${connectionId}', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
  `)
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${projectId}', 'SQLite Queue Contention Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(jobId, promptPairs, 'server-seed')

  const sqlitePath = getJudgmentJobSqlitePath(jobId)

  const workerScript = `
    import {existsSync, mkdirSync, writeFileSync} from 'node:fs'
    import {dirname} from 'node:path'
    import {randomUUID} from 'node:crypto'
    import {Database} from 'bun:sqlite'

    const sqlitePath = process.env.SQLITE_PATH
    const readyPath = process.env.SQLITE_READY_PATH
    const startPath = process.env.SQLITE_START_PATH
    const workerId = process.env.SQLITE_WORKER_ID

    if (!sqlitePath || !readyPath || !startPath || !workerId) {
      throw new Error('Missing SQLite worker env')
    }

    const waitForStart = () => {
      return existsSync(startPath)
        ? Promise.resolve()
        : new Promise((resolve) => {
            setTimeout(() => resolve(waitForStart()), 10)
          })
    }

    mkdirSync(dirname(readyPath), {recursive: true})
    writeFileSync(readyPath, 'ready')
    await waitForStart()

    const database = new Database(sqlitePath)
    database.exec(\`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
    \`)
    const selectReady = database.query(\`
      SELECT id, article_id AS articleId, prompt_id AS promptId
      FROM queue_prompt
      WHERE status = 'ready'
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    \`)
    const markSent = database.query(\`
      UPDATE queue_prompt
      SET status = 'sent',
          sent_at = ?,
          updated_at = ?,
          server_id = ?,
          claim_id = ?
      WHERE id = ?
        AND status = 'ready'
    \`)
    const waitForRetry = () => {
      return new Promise((resolve) => {
        setTimeout(resolve, 5)
      })
    }
    const claimOnePrompt = async () => {
      try {
        return database.transaction(() => {
          const now = new Date().toISOString()
          const row = selectReady.get() as {articleId: string; id: string; promptId: string} | null

          if (!row) {
            return []
          }

          const result = markSent.run(now, now, workerId, randomUUID(), row.id) as {changes?: number}

          return result.changes === 1 ? [{articleId: row.articleId, promptId: row.promptId}] : []
        })()
      } catch (error) {
        const isBusyError = error instanceof Error && 'code' in error && ['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT'].includes(String(error.code))

        if (isBusyError) {
          await waitForRetry()
          return claimOnePrompt()
        }

        throw error
      }
    }
    const claimUntilEmpty = async (claims) => {
      const nextClaims = await claimOnePrompt()
      return nextClaims.length === 0 ? claims : claimUntilEmpty([...claims, ...nextClaims])
    }

    const claims = await claimUntilEmpty([])
    database.close()
    process.stdout.write(JSON.stringify({claims}))
  `

  const workers = readyPaths.map((readyPath, index) => {
    return globalThis.Bun.spawn(['bun', '-e', workerScript], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SQLITE_PATH: sqlitePath,
        SQLITE_READY_PATH: readyPath,
        SQLITE_START_PATH: startPath,
        SQLITE_WORKER_ID: `writer-${index + 1}`,
      },
      stderr: 'pipe',
      stdout: 'pipe',
    })
  })

  try {
    await waitForPaths(readyPaths, 15_000)

    writeFileSync(startPath, 'start')

    const results = await Promise.all(
      workers.map(async (worker) => {
        const exitCode = await worker.exited
        const stdout = await new Response(worker.stdout).text()
        const stderr = await new Response(worker.stderr).text()

        return {exitCode, stderr, stdout}
      }),
    )

    results.forEach(({exitCode, stderr}) => {
      if (exitCode !== 0 || stderr !== '') {
        throw new Error(`SQLite contention worker failed: exit=${exitCode} stderr=${stderr}`)
      }
    })

    const claims = results.flatMap(({stdout}) => {
      return (JSON.parse(stdout) as {claims: Array<{articleId: string; promptId: string}>}).claims
    })
    const uniqueClaims = new Set(
      claims.map((claim) => {
        return `${jobId}:${claim.articleId}:${claim.promptId}`
      }),
    )
    const expectedClaims = new Set(
      promptPairs.map((pair) => {
        return `${jobId}:${pair.articleId}:${pair.promptId}`
      }),
    )

    expect(claims).toHaveLength(promptPairs.length)
    expect(uniqueClaims.size).toBe(promptPairs.length)
    expect(uniqueClaims).toEqual(expectedClaims)
    expect(await service.getReadyCount(jobId)).toBe(0)
    expect(await service.getInFlightCount(jobId)).toBe(promptPairs.length)
  } finally {
    workers.forEach((worker) => {
      if (worker.exitCode === null) {
        worker.kill('SIGTERM')
      }
    })
    await Promise.all(
      workers.map(async (worker) => {
        return worker.exitCode === null ? worker.exited.catch(() => {}) : undefined
      }),
    )
    rmSync(syncDir, {force: true, recursive: true})
  }
}, 20_000)

test('stores full SQLite scan state without clearing existing cursor fields', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-scan-${Date.now()}`
  const modelId = `model-scan-${Date.now()}`
  const projectId = `project-scan-${Date.now()}`
  const jobId = `job-scan-${Date.now()}`
  const seededCursorDate = new Date('2025-01-02T03:04:05.000Z')
  const updatedExhaustedAt = new Date('2025-01-03T03:04:05.000Z')

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('${connectionId}', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
  `)
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${projectId}', 'SQLite Scan State Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, cursor_last_created_at, cursor_last_article_id)
    VALUES ('${jobId}', '${projectId}', 'running', '${seededCursorDate.toISOString()}', 'seed-article')
  `)

  await service.initializeJob(jobId)

  expect(await service.getScanState(jobId)).toEqual({
    cursor: {lastArticleId: 'seed-article', lastDate: seededCursorDate},
    exhaustedAt: null,
    lastProjectRefreshAckSeq: null,
    scanEpoch: 0,
    wrapVisibilityAckSeq: null,
  })

  await service.setScanState(jobId, {lastProjectRefreshAckSeq: 17, scanEpoch: 2, wrapVisibilityAckSeq: 19})

  expect(await service.getScanState(jobId)).toEqual({
    cursor: {lastArticleId: 'seed-article', lastDate: seededCursorDate},
    exhaustedAt: null,
    lastProjectRefreshAckSeq: 17,
    scanEpoch: 2,
    wrapVisibilityAckSeq: 19,
  })

  await service.setExhaustedAt(jobId, updatedExhaustedAt)

  expect(await service.getScanState(jobId)).toEqual({
    cursor: {lastArticleId: 'seed-article', lastDate: seededCursorDate},
    exhaustedAt: updatedExhaustedAt,
    lastProjectRefreshAckSeq: 17,
    scanEpoch: 2,
    wrapVisibilityAckSeq: 19,
  })

  await service.setLastProjectRefreshAckSeq(jobId, 23)

  expect(await service.getScanState(jobId)).toEqual({
    cursor: {lastArticleId: 'seed-article', lastDate: seededCursorDate},
    exhaustedAt: updatedExhaustedAt,
    lastProjectRefreshAckSeq: 23,
    scanEpoch: 2,
    wrapVisibilityAckSeq: 19,
  })

  await service.setLastProjectRefreshAckSeq(jobId, 19)
  await service.setScanState(jobId, {lastProjectRefreshAckSeq: 11})

  expect(await service.getScanState(jobId)).toEqual({
    cursor: {lastArticleId: 'seed-article', lastDate: seededCursorDate},
    exhaustedAt: updatedExhaustedAt,
    lastProjectRefreshAckSeq: 23,
    scanEpoch: 2,
    wrapVisibilityAckSeq: 19,
  })

  await service.setScanState(jobId, {wrapVisibilityAckSeq: null})

  expect(await service.getScanState(jobId)).toEqual({
    cursor: {lastArticleId: 'seed-article', lastDate: seededCursorDate},
    exhaustedAt: updatedExhaustedAt,
    lastProjectRefreshAckSeq: 23,
    scanEpoch: 2,
    wrapVisibilityAckSeq: null,
  })
})

test('claims, reaps, releases, and completes outbox batches', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-outbox-${Date.now()}`
  const modelId = `model-outbox-${Date.now()}`
  const projectId = `project-outbox-${Date.now()}`
  const jobId = `job-outbox-${Date.now()}`
  const promptId = `prompt-outbox-${Date.now()}`
  const articleId = `article-outbox-${Date.now()}`

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('${connectionId}', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
  `)
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${projectId}', 'SQLite Outbox Claim Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(jobId, [{articleId, promptId}], 'server-a')

  const [claimedPrompt] = await service.claimReadyPrompts(jobId, 'server-a', 1)

  if (!claimedPrompt) {
    throw new Error('Failed to claim SQLite queue prompt')
  }

  await service.recordJudgmentSuccess(jobId, {
    answeredOriginal: 'yes',
    answeredOriginalAsArray: ['yes'],
    articleId,
    chunkingStrategy: null,
    confidenceOriginal: 50,
    createdAt: new Date(),
    explanation: 'because',
    isAnswered: true,
    judgmentId: `judgment-outbox-${Date.now()}`,
    modelId,
    projectId,
    promptId,
    queuePromptId: claimedPrompt.recordId,
    quotes: ['quote'],
    rawResponseJson: {answer: 'yes'},
    snapshotProjectId: projectId,
    snapshotProjectModelName: 'Qwen 35B',
    updatedAt: new Date(),
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  })

  const firstClaim = await service.claimPendingOutboxBatch({
    claimedBy: 'server-a',
    jobId,
    maxBytes: 1024 * 1024,
    maxRows: 10,
  })

  expect(firstClaim?.rows).toHaveLength(1)
  expect(
    await service.claimPendingOutboxBatch({claimedBy: 'server-b', jobId, maxBytes: 1024 * 1024, maxRows: 10}),
  ).toBeNull()
  expect(await service.reapStaleOutboxClaims({jobId, staleBefore: new Date(Date.now() + 1000)})).toBe(1)

  const secondClaim = await service.claimPendingOutboxBatch({
    claimedBy: 'server-b',
    jobId,
    maxBytes: 1024 * 1024,
    maxRows: 10,
  })

  expect(secondClaim?.rows).toHaveLength(1)
  expect(
    await service.releaseOutboxClaim({
      claimId: secondClaim?.claim.claimId ?? '',
      errorMessage: 'temporary failure',
      jobId,
    }),
  ).toBe(1)

  const thirdClaim = await service.claimPendingOutboxBatch({
    claimedBy: 'server-c',
    jobId,
    maxBytes: 1024 * 1024,
    maxRows: 10,
  })

  expect(thirdClaim?.rows).toHaveLength(1)
  expect(await service.completeOutboxClaim({claimId: thirdClaim?.claim.claimId ?? '', jobId})).toBe(1)
  expect(await service.getUnexportedOutboxCount(jobId)).toBe(0)
})

test('computes a per-job SQLite health snapshot', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-health-${Date.now()}`
  const modelId = `model-health-${Date.now()}`
  const projectId = `project-health-${Date.now()}`
  const jobId = `job-health-${Date.now()}`

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('${connectionId}', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
  `)
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${projectId}', 'SQLite Health Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(
    jobId,
    [
      {articleId: 'article-health-ready', promptId: 'prompt-health-ready'},
      {articleId: 'article-health-judged', promptId: 'prompt-health-judged'},
      {articleId: 'article-health-skipped', promptId: 'prompt-health-skipped'},
      {articleId: 'article-health-sent', promptId: 'prompt-health-sent'},
    ],
    'server-a',
  )

  const [judgedPrompt, skippedPrompt, sentPrompt] = await service.claimReadyPrompts(jobId, 'server-a', 3)

  if (!judgedPrompt || !skippedPrompt || !sentPrompt) {
    throw new Error('Failed to claim SQLite queue prompts for health snapshot test')
  }

  await service.recordJudgmentSuccess(jobId, {
    answeredOriginal: 'yes',
    answeredOriginalAsArray: ['yes'],
    articleId: judgedPrompt.articleId,
    chunkingStrategy: null,
    confidenceOriginal: 50,
    createdAt: new Date(Date.now() - 1_000),
    explanation: 'because',
    isAnswered: true,
    judgmentId: `judgment-health-${Date.now()}`,
    modelId,
    projectId,
    promptId: judgedPrompt.promptId,
    queuePromptId: judgedPrompt.recordId,
    quotes: ['quote'],
    rawResponseJson: {answer: 'yes'},
    snapshotProjectId: projectId,
    snapshotProjectModelName: 'Qwen 35B',
    updatedAt: new Date(),
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  })
  await service.markPromptAsSkipped(jobId, skippedPrompt.recordId, 'no_fulltext')

  const claimedOutboxBatch = await service.claimPendingOutboxBatch({
    claimedBy: 'server-a',
    jobId,
    maxBytes: 1024 * 1024,
    maxRows: 10,
  })
  const lastAckSeq = claimedOutboxBatch?.rows[0]?.outboxSeq ?? null

  await service.setLastProjectRefreshAckSeq(jobId, lastAckSeq)

  const snapshot = await service.getHealthSnapshot(jobId)

  expect(snapshot.sqliteFileBytes).not.toBeNull()
  expect(snapshot.sqliteFileBytes ?? 0).toBeGreaterThan(0)
  expect(snapshot.walBytes).toBeGreaterThanOrEqual(0)
  expect(snapshot.outboxRowCount).toBe(1)
  expect(snapshot.oldestUnexportedAgeMs).toBeGreaterThanOrEqual(0)
  expect(snapshot.claimedOutboxCount).toBe(1)
  expect(snapshot.promptCounts).toEqual({judged: 1, ready: 1, sent: 1, skipped: 1})
  expect(snapshot.lastAckSeq).toBe(lastAckSeq)
  expect(snapshot.retainedRowCount).toBe(4)
})

test('returns safe health snapshot defaults when the SQLite job db is missing', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-health-missing-${Date.now()}`
  const modelId = `model-health-missing-${Date.now()}`
  const projectId = `project-health-missing-${Date.now()}`
  const jobId = `job-health-missing-${Date.now()}`

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('${connectionId}', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
  `)
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id)
    VALUES ('${projectId}', 'SQLite Missing Health Test', '${modelId}')
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  expect(await service.getHealthSnapshot(jobId)).toEqual({
    claimedOutboxCount: 0,
    lastAckSeq: null,
    oldestUnexportedAgeMs: null,
    outboxRowCount: 0,
    promptCounts: {judged: 0, ready: 0, sent: 0, skipped: 0},
    retainedRowCount: 0,
    sqliteFileBytes: null,
    walBytes: 0,
  })
})

test('prunes only visibility-acked exported outbox rows in bounded batches', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-retention-${Date.now()}`
  const modelId = `model-retention-${Date.now()}`
  const projectId = `project-retention-${Date.now()}`
  const jobId = `job-retention-${Date.now()}`

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('${connectionId}', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
  `)
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${projectId}', 'SQLite Retention Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(
    jobId,
    [
      {articleId: 'article-retention-1', promptId: 'prompt-retention-1'},
      {articleId: 'article-retention-2', promptId: 'prompt-retention-2'},
      {articleId: 'article-retention-3', promptId: 'prompt-retention-3'},
    ],
    'server-a',
  )

  const claimedPrompts = await service.claimReadyPrompts(jobId, 'server-a', 3)

  await Promise.all(
    claimedPrompts.map((claimedPrompt, index) => {
      const suffix = index + 1

      return service.recordJudgmentSuccess(jobId, {
        answeredOriginal: 'yes',
        answeredOriginalAsArray: ['yes'],
        articleId: claimedPrompt.articleId,
        chunkingStrategy: null,
        confidenceOriginal: 50,
        createdAt: new Date(),
        explanation: 'because',
        isAnswered: true,
        judgmentId: `judgment-retention-${suffix}-${Date.now()}`,
        modelId,
        projectId,
        promptId: claimedPrompt.promptId,
        queuePromptId: claimedPrompt.recordId,
        quotes: ['quote'],
        rawResponseJson: {answer: 'yes'},
        snapshotProjectId: projectId,
        snapshotProjectModelName: 'Qwen 35B',
        updatedAt: new Date(),
        useAbstract: true,
        useFulltext: false,
        useFulltextNoImages: false,
        useTitle: true,
      })
    }),
  )

  const claimedOutboxBatch = await service.claimPendingOutboxBatch({
    claimedBy: 'server-a',
    jobId,
    maxBytes: 1024 * 1024,
    maxRows: 10,
  })
  const outboxSeqsByPromptId = new Map(
    (claimedOutboxBatch?.rows ?? []).map((row) => {
      return [row.queuePromptId, row.outboxSeq]
    }),
  )
  const sortedOutboxSeqs = claimedPrompts
    .map((claimedPrompt) => {
      return outboxSeqsByPromptId.get(claimedPrompt.recordId) ?? null
    })
    .filter((outboxSeq): outboxSeq is number => {
      return outboxSeq !== null
    })
    .sort((left, right) => {
      return left - right
    })
  const ackedOutboxSeq = sortedOutboxSeqs[1] ?? null
  const [newestOutboxSeq = null] = sortedOutboxSeqs.slice(-1)

  await service.completeOutboxClaim({claimId: claimedOutboxBatch?.claim.claimId ?? '', jobId})
  await service.setLastProjectRefreshAckSeq(jobId, ackedOutboxSeq)

  expect(await service.getOutboxCount(jobId)).toBe(3)

  const firstPrune = await service.pruneVisibilityAckedRetention({jobId, maxRows: 1})

  expect(firstPrune).toEqual({outboxRowsDeleted: 1, queuePromptRowsDeleted: 1})
  expect(await service.getOutboxCount(jobId)).toBe(2)
  expect(
    (await service.getPromptStatusCounts(jobId)).find((row) => {
      return row.status === 'judged'
    })?.count ?? 0,
  ).toBe(2)

  const secondPrune = await service.pruneVisibilityAckedRetention({jobId, maxRows: 10})

  expect(secondPrune).toEqual({outboxRowsDeleted: 1, queuePromptRowsDeleted: 1})
  expect(await service.getOutboxCount(jobId)).toBe(1)
  expect(await service.getMaxOutboxSeq(jobId)).toBe(newestOutboxSeq)
  expect(
    (await service.getPromptStatusCounts(jobId)).find((row) => {
      return row.status === 'judged'
    })?.count ?? 0,
  ).toBe(1)
})

test('keeps skipped and unacked prompt rows during visibility-acked retention cleanup', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-retention-skip-${Date.now()}`
  const modelId = `model-retention-skip-${Date.now()}`
  const projectId = `project-retention-skip-${Date.now()}`
  const jobId = `job-retention-skip-${Date.now()}`

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('${connectionId}', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
  `)
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${projectId}', 'SQLite Retention Skip Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(
    jobId,
    [
      {articleId: 'article-retention-acked', promptId: 'prompt-retention-acked'},
      {articleId: 'article-retention-skipped', promptId: 'prompt-retention-skipped'},
      {articleId: 'article-retention-unacked', promptId: 'prompt-retention-unacked'},
    ],
    'server-a',
  )

  const claimedPrompts = await service.claimReadyPrompts(jobId, 'server-a', 3)
  const ackedPrompt = claimedPrompts[0]
  const skippedPrompt = claimedPrompts[1]
  const unackedPrompt = claimedPrompts[2]

  if (!ackedPrompt || !skippedPrompt || !unackedPrompt) {
    throw new Error('Failed to claim SQLite queue prompts for retention cleanup test')
  }

  await service.recordJudgmentSuccess(jobId, {
    answeredOriginal: 'yes',
    answeredOriginalAsArray: ['yes'],
    articleId: ackedPrompt.articleId,
    chunkingStrategy: null,
    confidenceOriginal: 50,
    createdAt: new Date(),
    explanation: 'because',
    isAnswered: true,
    judgmentId: `judgment-retention-acked-${Date.now()}`,
    modelId,
    projectId,
    promptId: ackedPrompt.promptId,
    queuePromptId: ackedPrompt.recordId,
    quotes: ['quote'],
    rawResponseJson: {answer: 'yes'},
    snapshotProjectId: projectId,
    snapshotProjectModelName: 'Qwen 35B',
    updatedAt: new Date(),
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  })
  await service.markPromptAsSkipped(jobId, skippedPrompt.recordId, 'no_fulltext')
  await service.recordJudgmentSuccess(jobId, {
    answeredOriginal: 'yes',
    answeredOriginalAsArray: ['yes'],
    articleId: unackedPrompt.articleId,
    chunkingStrategy: null,
    confidenceOriginal: 50,
    createdAt: new Date(),
    explanation: 'because',
    isAnswered: true,
    judgmentId: `judgment-retention-unacked-${Date.now()}`,
    modelId,
    projectId,
    promptId: unackedPrompt.promptId,
    queuePromptId: unackedPrompt.recordId,
    quotes: ['quote'],
    rawResponseJson: {answer: 'yes'},
    snapshotProjectId: projectId,
    snapshotProjectModelName: 'Qwen 35B',
    updatedAt: new Date(),
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  })

  const claimedOutboxBatch = await service.claimPendingOutboxBatch({
    claimedBy: 'server-a',
    jobId,
    maxBytes: 1024 * 1024,
    maxRows: 10,
  })
  const ackedOutboxSeq = (claimedOutboxBatch?.rows ?? []).find((row) => {
    return row.queuePromptId === ackedPrompt.recordId
  })?.outboxSeq

  await service.completeOutboxClaim({claimId: claimedOutboxBatch?.claim.claimId ?? '', jobId})
  await service.setLastProjectRefreshAckSeq(jobId, ackedOutboxSeq ?? null)

  expect(await service.pruneVisibilityAckedRetention({jobId, maxRows: 10})).toEqual({
    outboxRowsDeleted: 1,
    queuePromptRowsDeleted: 1,
  })
  expect(await service.hasLocalJudgment(jobId, ackedPrompt.articleId, ackedPrompt.promptId)).toBe(false)
  expect(await service.hasLocalJudgment(jobId, skippedPrompt.articleId, skippedPrompt.promptId)).toBe(true)
  expect(await service.hasLocalJudgment(jobId, unackedPrompt.articleId, unackedPrompt.promptId)).toBe(true)
  expect(await service.getOutboxCount(jobId)).toBe(1)
})

test('deletes drained completed SQLite jobs after visibility cleanup finishes', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-drained-delete-${Date.now()}`
  const modelId = `model-drained-delete-${Date.now()}`
  const projectId = `project-drained-delete-${Date.now()}`
  const jobId = `job-drained-delete-${Date.now()}`

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('${connectionId}', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
  `)
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${projectId}', 'SQLite Drained Delete Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'completed')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(
    jobId,
    [
      {articleId: 'article-drained-acked', promptId: 'prompt-drained-acked'},
      {articleId: 'article-drained-skipped', promptId: 'prompt-drained-skipped'},
    ],
    'server-a',
  )

  const claimedPrompts = await service.claimReadyPrompts(jobId, 'server-a', 2)
  const ackedPrompt = claimedPrompts[0]
  const skippedPrompt = claimedPrompts[1]

  if (!ackedPrompt || !skippedPrompt) {
    throw new Error('Failed to claim SQLite queue prompts for drained delete test')
  }

  await service.recordJudgmentSuccess(jobId, {
    answeredOriginal: 'yes',
    answeredOriginalAsArray: ['yes'],
    articleId: ackedPrompt.articleId,
    chunkingStrategy: null,
    confidenceOriginal: 50,
    createdAt: new Date(),
    explanation: 'because',
    isAnswered: true,
    judgmentId: `judgment-drained-acked-${Date.now()}`,
    modelId,
    projectId,
    promptId: ackedPrompt.promptId,
    queuePromptId: ackedPrompt.recordId,
    quotes: ['quote'],
    rawResponseJson: {answer: 'yes'},
    snapshotProjectId: projectId,
    snapshotProjectModelName: 'Qwen 35B',
    updatedAt: new Date(),
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  })
  await service.markPromptAsSkipped(jobId, skippedPrompt.recordId, 'no_fulltext')

  const claimedOutboxBatch = await service.claimPendingOutboxBatch({
    claimedBy: 'server-a',
    jobId,
    maxBytes: 1024 * 1024,
    maxRows: 10,
  })
  const ackedOutboxSeq = claimedOutboxBatch?.rows[0]?.outboxSeq ?? null

  await service.completeOutboxClaim({claimId: claimedOutboxBatch?.claim.claimId ?? '', jobId})
  await service.setLastProjectRefreshAckSeq(jobId, ackedOutboxSeq)
  await service.pruneVisibilityAckedRetention({jobId, maxRows: 10})

  expect(existsSync(getJudgmentJobSqlitePath(jobId))).toBe(true)
  expect(existsSync(getJudgmentJobLeasePath(jobId))).toBe(true)
  expect(await service.deleteDrainedJobs({jobId})).toEqual([jobId])
  expect(existsSync(getJudgmentJobSqlitePath(jobId))).toBe(false)
  expect(existsSync(getJudgmentJobLeasePath(jobId))).toBe(false)
})

test('keeps completed SQLite jobs on disk while visibility-gated outbox data remains', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-drained-keep-${Date.now()}`
  const modelId = `model-drained-keep-${Date.now()}`
  const projectId = `project-drained-keep-${Date.now()}`
  const jobId = `job-drained-keep-${Date.now()}`

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('${connectionId}', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
  `)
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${projectId}', 'SQLite Drained Keep Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'completed')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(
    jobId,
    [{articleId: 'article-drained-pending', promptId: 'prompt-drained-pending'}],
    'server-a',
  )

  const [claimedPrompt] = await service.claimReadyPrompts(jobId, 'server-a', 1)

  if (!claimedPrompt) {
    throw new Error('Failed to claim SQLite queue prompt for drained keep test')
  }

  await service.recordJudgmentSuccess(jobId, {
    answeredOriginal: 'yes',
    answeredOriginalAsArray: ['yes'],
    articleId: claimedPrompt.articleId,
    chunkingStrategy: null,
    confidenceOriginal: 50,
    createdAt: new Date(),
    explanation: 'because',
    isAnswered: true,
    judgmentId: `judgment-drained-pending-${Date.now()}`,
    modelId,
    projectId,
    promptId: claimedPrompt.promptId,
    queuePromptId: claimedPrompt.recordId,
    quotes: ['quote'],
    rawResponseJson: {answer: 'yes'},
    snapshotProjectId: projectId,
    snapshotProjectModelName: 'Qwen 35B',
    updatedAt: new Date(),
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  })
  await service.claimPendingOutboxBatch({claimedBy: 'server-a', jobId, maxBytes: 1024 * 1024, maxRows: 10})
  await service.completeOutboxClaim({
    claimId: (await service.getClaimedOutboxBatch({jobId, serverJobId: 'server-a'}))?.claim.claimId ?? '',
    jobId,
  })

  expect(await service.getOutboxCount(jobId)).toBe(1)
  expect(await service.deleteDrainedJobs({jobId})).toEqual([])
  expect(existsSync(getJudgmentJobSqlitePath(jobId))).toBe(true)
})

test('keeps completed SQLite jobs on disk until export, visibility ack, and retention cleanup all drain', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-drain-lifecycle-${Date.now()}`
  const modelId = `model-drain-lifecycle-${Date.now()}`
  const projectId = `project-drain-lifecycle-${Date.now()}`
  const jobId = `job-drain-lifecycle-${Date.now()}`

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('${connectionId}', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
  `)
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${projectId}', 'SQLite Drain Lifecycle Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'completed')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(
    jobId,
    [{articleId: 'article-drain-lifecycle', promptId: 'prompt-drain-lifecycle'}],
    'server-a',
  )

  const sqlitePath = getJudgmentJobSqlitePath(jobId)
  const leasePath = getJudgmentJobLeasePath(jobId)
  const [claimedPrompt] = await service.claimReadyPrompts(jobId, 'server-a', 1)

  if (!claimedPrompt) {
    throw new Error('Failed to claim SQLite queue prompt for drain lifecycle test')
  }

  await service.recordJudgmentSuccess(jobId, {
    answeredOriginal: 'yes',
    answeredOriginalAsArray: ['yes'],
    articleId: claimedPrompt.articleId,
    chunkingStrategy: null,
    confidenceOriginal: 50,
    createdAt: new Date(),
    explanation: 'because',
    isAnswered: true,
    judgmentId: `judgment-drain-lifecycle-${Date.now()}`,
    modelId,
    projectId,
    promptId: claimedPrompt.promptId,
    queuePromptId: claimedPrompt.recordId,
    quotes: ['quote'],
    rawResponseJson: {answer: 'yes'},
    snapshotProjectId: projectId,
    snapshotProjectModelName: 'Qwen 35B',
    updatedAt: new Date(),
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  })

  expect(await service.getOutboxCount(jobId)).toBe(1)
  expect(await service.hasLocalJudgment(jobId, claimedPrompt.articleId, claimedPrompt.promptId)).toBe(true)
  expect(await service.deleteDrainedJobs({jobId})).toEqual([])
  expect(existsSync(sqlitePath)).toBe(true)
  expect(existsSync(leasePath)).toBe(true)

  const claimedOutboxBatch = await service.claimPendingOutboxBatch({
    claimedBy: 'server-a',
    jobId,
    maxBytes: 1024 * 1024,
    maxRows: 10,
  })
  const outboxSeq = claimedOutboxBatch?.rows[0]?.outboxSeq ?? null

  await service.completeOutboxClaim({claimId: claimedOutboxBatch?.claim.claimId ?? '', jobId})

  expect(await service.getOutboxCount(jobId)).toBe(1)
  expect(await service.deleteDrainedJobs({jobId})).toEqual([])
  expect(existsSync(sqlitePath)).toBe(true)
  expect(existsSync(leasePath)).toBe(true)

  await service.setLastProjectRefreshAckSeq(jobId, outboxSeq)

  expect(await service.getOutboxCount(jobId)).toBe(1)
  expect(await service.hasLocalJudgment(jobId, claimedPrompt.articleId, claimedPrompt.promptId)).toBe(true)
  expect(await service.deleteDrainedJobs({jobId})).toEqual([])
  expect(existsSync(sqlitePath)).toBe(true)
  expect(existsSync(leasePath)).toBe(true)

  expect(await service.pruneVisibilityAckedRetention({jobId, maxRows: 10})).toEqual({
    outboxRowsDeleted: 1,
    queuePromptRowsDeleted: 1,
  })
  expect(await service.getOutboxCount(jobId)).toBe(0)
  expect(await service.hasLocalJudgment(jobId, claimedPrompt.articleId, claimedPrompt.promptId)).toBe(false)
  expect(await service.deleteDrainedJobs({jobId})).toEqual([jobId])
  expect(existsSync(sqlitePath)).toBe(false)
  expect(existsSync(leasePath)).toBe(false)
})

test('syncOwnedLeases releases only inactive SQLite job leases', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-sync-${Date.now()}`
  const modelId = `model-sync-${Date.now()}`
  const firstProjectId = `project-sync-a-${Date.now()}`
  const firstJobId = `job-sync-a-${Date.now()}`
  const secondProjectId = `project-sync-b-${Date.now()}`
  const secondJobId = `job-sync-b-${Date.now()}`

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('${connectionId}', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
  `)
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${firstProjectId}', 'SQLite Lease Sync A', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${secondProjectId}', 'SQLite Lease Sync B', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${firstJobId}', '${firstProjectId}', 'running')
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${secondJobId}', '${secondProjectId}', 'running')
  `)

  await service.initializeJob(firstJobId)
  await service.initializeJob(secondJobId)
  await service.ensureOwnedLease(firstJobId, 'server-a')
  await service.ensureOwnedLease(secondJobId, 'server-a')

  expect(service.hasOwnedLease(firstJobId)).toBe(true)
  expect(service.hasOwnedLease(secondJobId)).toBe(true)
  expect(existsSync(getJudgmentJobLeasePath(firstJobId))).toBe(true)
  expect(existsSync(getJudgmentJobLeasePath(secondJobId))).toBe(true)

  await service.syncOwnedLeases([firstJobId])

  expect(service.hasOwnedLease(firstJobId)).toBe(true)
  expect(service.hasOwnedLease(secondJobId)).toBe(false)
  expect(existsSync(getJudgmentJobLeasePath(firstJobId))).toBe(true)
  expect(existsSync(getJudgmentJobLeasePath(secondJobId))).toBe(false)
})
