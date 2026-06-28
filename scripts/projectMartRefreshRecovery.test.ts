import {existsSync, rmSync} from 'node:fs'
import {dirname, join} from 'node:path'

import {expect, test} from 'bun:test'

const projectRoot = process.cwd()
const defaultEnv = {
  ...process.env,
  API_SERVER_PORT: '39102',
  RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
  RUN_SERVER_FULL_TEXT_FETCHING: 'false',
  SERVER_ROLE: 'maintenance-worker',
  VITE_PORT: '39912',
}

const inspectScriptPath = join(projectRoot, 'scripts/inspectDirtyRefreshRisk.ts')
const recoverScriptPath = join(projectRoot, 'scripts/recoverDirtyRefreshClaims.ts')
const runOnceScriptPath = join(projectRoot, 'scripts/runProjectMartRefreshWorkerOnceIsolated.ts')

const getLastJsonLine = (output: string) => {
  const [lastLine = ''] = output
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      return line.trim()
    })
    .filter((line) => {
      return (line.startsWith('{') && line.endsWith('}')) || (line.startsWith('[') && line.endsWith(']'))
    })
    .slice(-1)

  if (lastLine === '') {
    throw new Error(`Expected JSON output but received: ${output}`)
  }

  return lastLine
}

const removeFileIfExists = (filePath: string) => {
  if (existsSync(filePath)) {
    rmSync(filePath, {force: true, recursive: true})
  }
}

const seedProjectSql = ({
  dirtyArticleCount,
  projectId,
  refreshStatus,
}: {
  dirtyArticleCount: number
  projectId: string
  refreshStatus: 'idle' | 'running'
}) => {
  const articleValues = Array.from({length: dirtyArticleCount}, (_, index) => {
    const articleIndex = index + 1
    return `('article-${articleIndex}', 'Article ${articleIndex}', TIMESTAMPTZ '2026-03-10T00:00:00.000Z', TIMESTAMPTZ '2026-03-10T00:00:00.000Z', 'external-${articleIndex}')`
  }).join(',\n              ')
  const projectArticleValues = Array.from({length: dirtyArticleCount}, (_, index) => {
    const articleIndex = index + 1
    return `('project-article-${articleIndex}', '${projectId}', 'article-${articleIndex}')`
  }).join(',\n              ')
  const dirtyArticleStateValues = Array.from({length: dirtyArticleCount}, (_, index) => {
    const articleIndex = index + 1
    return `('${projectId}', 'article-${articleIndex}', 1, 1, TIMESTAMPTZ '2026-04-02T12:01:00.000Z')`
  }).join(',\n              ')

  return `
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('connection-${projectId}', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1');

    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('model-${projectId}', 'connection-${projectId}', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE);

    INSERT INTO app.project (id, name, archived, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${projectId}', 'Project ${projectId}', FALSE, 'model-${projectId}', TRUE, TRUE, FALSE, FALSE);

    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES ('prompt-${projectId}', 'Prompt ${projectId}', 'hash-${projectId}');

    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled)
    VALUES ('project-prompt-${projectId}', '${projectId}', 'prompt-${projectId}', 1, TRUE);

    INSERT INTO app.article (id, article_title, article_created_at, article_updated_at, article_id)
    VALUES ${articleValues};

    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES ${projectArticleValues};

    INSERT INTO app.project_mart_refresh_state (
      project_id,
      dirty_token,
      active_dirty_token,
      last_completed_dirty_token,
      last_requested_at,
      refresh_status,
      last_started_at,
      lease_expires_at
    ) VALUES (
      '${projectId}',
      1,
      ${refreshStatus === 'running' ? 1 : 0},
      0,
      TIMESTAMPTZ '2026-04-02T12:00:00.000Z',
      '${refreshStatus}',
      TIMESTAMPTZ '2026-04-02T12:00:30.000Z',
      TIMESTAMPTZ '2026-04-02T12:01:00.000Z'
    );

    INSERT INTO app.project_mart_refresh_article_state (
      project_id,
      article_id,
      first_dirty_token,
      last_dirty_token,
      updated_at
    ) VALUES ${dirtyArticleStateValues};
  `
}

const seedDatabase = ({
  dirtyArticleCount,
  duckdbPath,
  projectId,
  refreshStatus,
}: {
  dirtyArticleCount: number
  duckdbPath: string
  projectId: string
  refreshStatus: 'idle' | 'running'
}) => {
  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
        const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')

        await migrateDuckdb()
        const database = getAppDatabaseService()
        await database.run(${JSON.stringify(seedProjectSql({dirtyArticleCount, projectId, refreshStatus}))})
        await database.close()
      `,
    ],
    {cwd: projectRoot, env: {...defaultEnv, DUCKDB_PATH: duckdbPath}},
  )

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || result.stdout.toString() || 'project mart refresh seed failed')
  }
}

const runQuery = (duckdbPath: string, sql: string) => {
  const result = globalThis.Bun.spawnSync(['bun', 'scripts/dbQuerySnapshot.ts', `--sql=${sql}`], {
    cwd: projectRoot,
    env: {...defaultEnv, DUCKDB_PATH: duckdbPath},
  })

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || result.stdout.toString() || 'query failed')
  }

  return JSON.parse(getLastJsonLine(result.stdout.toString())) as unknown
}

test('inspectProjectMartRefreshRisk reports scope dirty count and planned mode', () => {
  const duckdbPath = join(projectRoot, '.tmp', 'inspect-project-mart-refresh-risk.duckdb')
  removeFileIfExists(dirname(duckdbPath))
  seedDatabase({dirtyArticleCount: 4, duckdbPath, projectId: 'project-inspect', refreshStatus: 'idle'})

  const runScript = globalThis.Bun.spawnSync(['bun', inspectScriptPath, '--project-id=project-inspect'], {
    cwd: projectRoot,
    env: {...defaultEnv, DUCKDB_PATH: duckdbPath},
  })

  if (runScript.exitCode !== 0) {
    throw new Error(runScript.stderr.toString() || runScript.stdout.toString() || 'inspect script failed')
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    dirtyArticleCount: number
    hasTrackedJudgmentJobs: boolean
    plannedRefreshMode: string
    projectId: string
    scopeArticleCount: number
  }

  expect(result).toMatchObject({
    dirtyArticleCount: 4,
    hasTrackedJudgmentJobs: false,
    plannedRefreshMode: 'full',
    projectId: 'project-inspect',
    scopeArticleCount: 4,
  })
})

test('runProjectMartRefreshWorkerOnce CLI completes one claim and leaves the ledger idle', () => {
  const duckdbPath = join(projectRoot, '.tmp', 'run-project-mart-refresh-worker-once.duckdb')
  removeFileIfExists(dirname(duckdbPath))
  seedDatabase({dirtyArticleCount: 1, duckdbPath, projectId: 'project-run-once', refreshStatus: 'idle'})

  const runScript = globalThis.Bun.spawnSync(
    ['bun', runOnceScriptPath, '--worker-id=test-worker', '--legacy-admin-ack=legacy-dirty-refresh'],
    {cwd: projectRoot, env: {...defaultEnv, DUCKDB_PATH: duckdbPath}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(runScript.stderr.toString() || runScript.stdout.toString() || 'run-once script failed')
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    projectId: string
    status: string
    workerId: string
  }

  expect(result).toMatchObject({projectId: 'project-run-once', status: 'completed', workerId: 'test-worker'})

  const [state] = runQuery(
    duckdbPath,
    "SELECT refresh_status AS refreshStatus, last_completed_dirty_token AS lastCompletedDirtyToken FROM app.project_mart_refresh_state WHERE project_id = 'project-run-once'",
  ) as Array<{lastCompletedDirtyToken: string; refreshStatus: string}>

  expect(state).toEqual({lastCompletedDirtyToken: '1', refreshStatus: 'idle'})
})

test('runProjectMartRefreshWorkerOnce legacy CLI blocks without admin acknowledgement', () => {
  const runScript = globalThis.Bun.spawnSync(['bun', runOnceScriptPath, '--worker-id=test-worker'], {
    cwd: projectRoot,
    env: {...defaultEnv, DUCKDB_PATH: join(projectRoot, '.tmp', 'unused-dirty-refresh.duckdb')},
  })

  expect(runScript.exitCode).toBe(1)
  expect(JSON.parse(getLastJsonLine(runScript.stderr.toString()))).toEqual({
    command: 'runProjectMartRefreshWorkerOnceIsolated',
    requiredAck: 'legacy-dirty-refresh',
    status: 'blocked_legacy_admin_ack_required',
  })
})

test('runProjectMartRefreshWorkerOnce routes oversized full refreshes into V4 rebuild requests', () => {
  const duckdbPath = join(projectRoot, '.tmp', 'run-project-mart-refresh-worker-once-blocked.duckdb')
  removeFileIfExists(dirname(duckdbPath))
  seedDatabase({dirtyArticleCount: 4, duckdbPath, projectId: 'project-blocked', refreshStatus: 'idle'})

  const runScript = globalThis.Bun.spawnSync(
    ['bun', runOnceScriptPath, '--worker-id=test-worker', '--legacy-admin-ack=legacy-dirty-refresh'],
    {
      cwd: projectRoot,
      env: {...defaultEnv, DUCKDB_PATH: duckdbPath, PROJECT_MART_REFRESH_MAX_FULL_SCOPE_ARTICLES: '3'},
    },
  )

  expect(runScript.exitCode).toBe(0)

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    projectId: string
    requestId: string
    status: string
    workerId: string
  }

  expect(result.projectId).toBe('project-blocked')
  expect(result.requestId).toBeTruthy()
  expect(result.status).toBe('v4_rebuild_requested')

  const [state] = runQuery(
    duckdbPath,
    "SELECT refresh_status AS refreshStatus, last_error AS lastError, CAST(active_dirty_token AS INTEGER) AS activeDirtyToken, CAST(last_completed_dirty_token AS INTEGER) AS lastCompletedDirtyToken FROM app.project_mart_refresh_state WHERE project_id = 'project-blocked'",
  ) as Array<{
    activeDirtyToken: number
    lastCompletedDirtyToken: number
    lastError: string | null
    refreshStatus: string
  }>
  const [request] = runQuery(
    duckdbPath,
    "SELECT project_id AS projectId, reason, status FROM app.review_rebuild_request WHERE project_id = 'project-blocked'",
  ) as Array<{projectId: string; reason: string; status: string}>
  const [largeRebuildCount] = runQuery(
    duckdbPath,
    "SELECT CAST(COUNT(*) AS INTEGER) AS count FROM app.project_mart_large_rebuild_state WHERE project_id = 'project-blocked' AND refresh_token > 0",
  ) as Array<{count: number}>

  expect(state.refreshStatus).toBe('idle')
  expect(state.lastError).toBeNull()
  expect(state.activeDirtyToken).toBe(0)
  expect(state.lastCompletedDirtyToken).toBe(1)
  expect(request).toEqual({
    projectId: 'project-blocked',
    reason: 'runProjectMartRefreshWorkerOnceIsolated.fullRefresh',
    status: 'admitted',
  })
  expect(largeRebuildCount).toEqual({count: 0})
})

test('recoverProjectMartRefreshClaims lists and recovers stale claims only when explicitly requested', () => {
  const duckdbPath = join(projectRoot, '.tmp', 'recover-project-mart-refresh-claims.duckdb')
  removeFileIfExists(dirname(duckdbPath))
  seedDatabase({dirtyArticleCount: 1, duckdbPath, projectId: 'project-recover', refreshStatus: 'running'})

  const listScript = globalThis.Bun.spawnSync(['bun', recoverScriptPath], {
    cwd: projectRoot,
    env: {...defaultEnv, DUCKDB_PATH: duckdbPath},
  })

  if (listScript.exitCode !== 0) {
    throw new Error(listScript.stderr.toString() || listScript.stdout.toString() || 'recover list script failed')
  }

  const listed = JSON.parse(getLastJsonLine(listScript.stdout.toString())) as {
    recoverAttempted: boolean
    staleClaims: Array<{projectId: string}>
    status: string
  }

  expect(listed.recoverAttempted).toBe(false)
  expect(listed.status).toBe('listed')
  expect(listed.staleClaims).toHaveLength(1)
  expect(listed.staleClaims[0]).toMatchObject({projectId: 'project-recover'})

  const recoverScript = globalThis.Bun.spawnSync(['bun', recoverScriptPath, '--recover', '--yes'], {
    cwd: projectRoot,
    env: {...defaultEnv, DUCKDB_PATH: duckdbPath},
  })

  if (recoverScript.exitCode !== 0) {
    throw new Error(recoverScript.stderr.toString() || recoverScript.stdout.toString() || 'recover script failed')
  }

  const recovered = JSON.parse(getLastJsonLine(recoverScript.stdout.toString())) as {
    recoverAttempted: boolean
    recoveryResult: {kind: string; projectIds: string[]; reason: string; requestIds: string[]}
    staleClaims: Array<{projectId: string}>
    status: string
  }

  expect(recovered.recoverAttempted).toBe(true)
  expect(recovered.status).toBe('recovered')
  expect(
    recovered.staleClaims.map((claim) => {
      return claim.projectId
    }),
  ).toEqual(['project-recover'])
  expect(recovered.recoveryResult).toMatchObject({
    kind: 'v4_rebuild_request',
    projectIds: ['project-recover'],
    reason: 'recoverDirtyRefreshClaims.staleDirtyRefreshClaim',
  })
  expect(recovered.recoveryResult.requestIds).toHaveLength(1)

  const [state] = runQuery(
    duckdbPath,
    "SELECT refresh_status AS refreshStatus, CAST(active_dirty_token AS INTEGER) AS activeDirtyToken, CAST(last_completed_dirty_token AS INTEGER) AS lastCompletedDirtyToken, lease_expires_at AS leaseExpiresAt FROM app.project_mart_refresh_state WHERE project_id = 'project-recover'",
  ) as Array<{
    activeDirtyToken: number
    lastCompletedDirtyToken: number
    leaseExpiresAt: string | null
    refreshStatus: string
  }>
  const [request] = runQuery(
    duckdbPath,
    "SELECT project_id AS projectId, reason, status FROM app.review_rebuild_request WHERE project_id = 'project-recover'",
  ) as Array<{projectId: string; reason: string; status: string}>

  expect(state).toEqual({activeDirtyToken: 0, lastCompletedDirtyToken: 1, leaseExpiresAt: null, refreshStatus: 'idle'})
  expect(request).toEqual({
    projectId: 'project-recover',
    reason: 'recoverDirtyRefreshClaims.staleDirtyRefreshClaim',
    status: 'admitted',
  })
})
