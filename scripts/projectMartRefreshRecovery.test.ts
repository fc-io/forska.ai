import {existsSync, rmSync} from 'node:fs'
import {dirname, join} from 'node:path'

import {expect, test} from 'bun:test'

const projectRoot = process.cwd()
const defaultEnv = {
  ...process.env,
  API_SERVER_PORT: '39102',
  RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
  RUN_SERVER_FULL_TEXT_FETCHING: 'false',
  SERVER_ROLE: 'writer',
  VITE_PORT: '39912',
}

const inspectScriptPath = join(projectRoot, 'scripts/inspectProjectMartRefreshRisk.ts')
const recoverScriptPath = join(projectRoot, 'scripts/recoverProjectMartRefreshClaims.ts')
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
      active_refresh_token,
      last_completed_refresh_token,
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

  return JSON.parse(getLastJsonLine(result.stdout.toString()))
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

  const runScript = globalThis.Bun.spawnSync(['bun', runOnceScriptPath, '--worker-id=test-worker'], {
    cwd: projectRoot,
    env: {...defaultEnv, DUCKDB_PATH: duckdbPath},
  })

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
    "SELECT refresh_status AS refreshStatus, last_completed_refresh_token AS lastCompletedRefreshToken FROM app.project_mart_refresh_state WHERE project_id = 'project-run-once'",
  ) as Array<{lastCompletedRefreshToken: string; refreshStatus: string}>

  expect(state).toEqual({lastCompletedRefreshToken: '1', refreshStatus: 'idle'})
})

test('runProjectMartRefreshWorkerOnce routes oversized full refreshes into staged large rebuild state', () => {
  const duckdbPath = join(projectRoot, '.tmp', 'run-project-mart-refresh-worker-once-blocked.duckdb')
  removeFileIfExists(dirname(duckdbPath))
  seedDatabase({dirtyArticleCount: 4, duckdbPath, projectId: 'project-blocked', refreshStatus: 'idle'})

  const runScript = globalThis.Bun.spawnSync(['bun', runOnceScriptPath, '--worker-id=test-worker'], {
    cwd: projectRoot,
    env: {...defaultEnv, DUCKDB_PATH: duckdbPath, PROJECT_MART_REFRESH_MAX_FULL_SCOPE_ARTICLES: '3'},
  })

  expect(runScript.exitCode).toBe(0)

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    projectId: string
    status: string
    workerId: string
  }

  expect(result.projectId).toBe('project-blocked')
  expect(result.status).toBe('completed')

  const [state] = runQuery(
    duckdbPath,
    "SELECT refresh_status AS refreshStatus, last_error AS lastError, CAST(active_refresh_token AS INTEGER) AS activeRefreshToken FROM app.project_mart_refresh_state WHERE project_id = 'project-blocked'",
  ) as Array<{activeRefreshToken: number; lastError: string | null; refreshStatus: string}>
  const [largeRebuildState] = runQuery(
    duckdbPath,
    "SELECT rebuild_phase AS rebuildPhase, refresh_status AS refreshStatus, CAST(refresh_token AS INTEGER) AS refreshToken FROM app.project_mart_large_rebuild_state WHERE project_id = 'project-blocked'",
  ) as Array<{rebuildPhase: string; refreshStatus: string; refreshToken: number}>

  expect(state.refreshStatus).toBe('idle')
  expect(state.lastError).toBeNull()
  expect(state.activeRefreshToken).toBe(0)
  expect(largeRebuildState).toEqual({rebuildPhase: 'prompt_answer_fact', refreshStatus: 'idle', refreshToken: 1})
})

test('isolated refresh command progresses one large rebuild batch when no normal refresh claim is available', () => {
  const duckdbPath = join(projectRoot, '.tmp', 'run-project-mart-large-rebuild-once.duckdb')
  removeFileIfExists(dirname(duckdbPath))
  seedDatabase({dirtyArticleCount: 1, duckdbPath, projectId: 'project-large-rebuild', refreshStatus: 'idle'})

  const seedLargeRebuild = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
        const database = getAppDatabaseService()
        await database.run(\`
          UPDATE app.project_mart_refresh_state
          SET dirty_token = 0, last_completed_refresh_token = 0, active_refresh_token = 0, refresh_status = 'idle'
          WHERE project_id = 'project-large-rebuild';
          DELETE FROM app.project_mart_refresh_article_state WHERE project_id = 'project-large-rebuild';
        \`)
        await database.run(\`
          INSERT INTO app.prompt (id, original_text, content_hash)
          VALUES ('prompt-large-rebuild', 'Prompt large rebuild', 'hash-large-rebuild')
        \`)
        await database.run(\`
          INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled)
          VALUES ('project-prompt-large-rebuild', 'project-large-rebuild', 'prompt-large-rebuild', 1, TRUE)
        \`)
        await database.run(\`
          INSERT INTO mart.project_scope_article (
            project_id,
            article_id,
            in_curated_scope,
            in_route_scope,
            article_created_at,
            article_updated_at
          ) VALUES (
            'project-large-rebuild',
            'article-1',
            TRUE,
            FALSE,
            TIMESTAMPTZ '2026-04-01T00:00:00.000Z',
            TIMESTAMPTZ '2026-04-01T01:00:00.000Z'
          )
        \`)
        await database.run(\`
          INSERT INTO mart.judgment_fact (
            judgment_id,
            article_id,
            prompt_id,
            model_id,
            project_id,
            snapshot_project_id,
            snapshot_project_model_name,
            use_title,
            use_abstract,
            use_fulltext,
            use_fulltext_no_images,
            chunking_strategy,
            is_answered,
            answered_original,
            answered_original_as_array,
            normalized_answers,
            confidence_original,
            explanation,
            quotes,
            article_title,
            article_created_at,
            article_updated_at,
            article_import_route,
            article_publication_status,
            created_at,
            updated_at
          ) VALUES (
            'judgment-large-rebuild',
            'article-1',
            'prompt-large-rebuild',
            'model-project-large-rebuild',
            'project-large-rebuild',
            'project-large-rebuild',
            'Project project-large-rebuild',
            TRUE,
            TRUE,
            FALSE,
            FALSE,
            NULL,
            TRUE,
            'yes',
            ['yes'],
            ['yes'],
            1,
            NULL,
            NULL,
            'Article 1',
            TIMESTAMPTZ '2026-04-01T00:00:00.000Z',
            TIMESTAMPTZ '2026-04-01T01:00:00.000Z',
            NULL,
            NULL,
            TIMESTAMPTZ '2026-04-03T00:00:00.000Z',
            TIMESTAMPTZ '2026-04-03T00:00:00.000Z'
          )
        \`)
        await database.run(\`
          INSERT INTO app.project_mart_large_rebuild_state (
            project_id,
            refresh_token,
            rebuild_phase,
            refresh_status
          ) VALUES (
            'project-large-rebuild',
            5,
            'prompt_answer_fact',
            'idle'
          )
        \`)
        await database.close()
      `,
    ],
    {cwd: projectRoot, env: {...defaultEnv, DUCKDB_PATH: duckdbPath}},
  )

  if (seedLargeRebuild.exitCode !== 0) {
    throw new Error(
      seedLargeRebuild.stderr.toString() || seedLargeRebuild.stdout.toString() || 'large rebuild seed failed',
    )
  }

  const runScript = globalThis.Bun.spawnSync(['bun', runOnceScriptPath, '--worker-id=test-large-rebuild'], {
    cwd: projectRoot,
    env: {...defaultEnv, DUCKDB_PATH: duckdbPath, SERVER_ROLE: 'writer', SERVER_WRITER_URL: ''},
  })

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString() || runScript.stdout.toString() || 'large rebuild run-once script failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    articleCount: number
    nextCursor: {articleCreatedAt: string; articleId: string} | null
    projectId: string
    status: string
    workerId: string
  }

  expect(result.articleCount).toBe(1)
  expect(result.projectId).toBe('project-large-rebuild')
  expect(result.status).toBe('progressed')
  expect(result.workerId).toBe('test-large-rebuild')
  expect(result.nextCursor?.articleId).toBe('article-1')
  expect(String(result.nextCursor?.articleCreatedAt ?? '')).toContain('2026-03-10')

  const [promptAnswerFactCount] = runQuery(
    duckdbPath,
    "SELECT COUNT(*) AS count FROM mart.prompt_answer_fact WHERE project_id = 'project-large-rebuild'",
  ) as Array<{count: string}>
  const [largeRebuildState] = runQuery(
    duckdbPath,
    "SELECT rebuild_phase AS rebuildPhase, refresh_status AS refreshStatus, cursor_article_id AS cursorArticleId FROM app.project_mart_large_rebuild_state WHERE project_id = 'project-large-rebuild'",
  ) as Array<{cursorArticleId: string | null; rebuildPhase: string; refreshStatus: string}>

  expect(promptAnswerFactCount).toEqual({count: '1'})
  expect(largeRebuildState).toEqual({
    cursorArticleId: 'article-1',
    rebuildPhase: 'prompt_answer_fact',
    refreshStatus: 'idle',
  })
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
    recoveryResult: {projectId: string; status: string}
    staleClaims: Array<{projectId: string}>
    status: string
  }

  expect(recovered.recoverAttempted).toBe(true)
  expect(recovered.status).toBe('recovered')
  expect(recovered.staleClaims.map((claim) => claim.projectId)).toEqual(['project-recover'])
  expect(recovered.recoveryResult).toMatchObject({projectId: 'project-recover', status: 'completed'})

  const [state] = runQuery(
    duckdbPath,
    "SELECT refresh_status AS refreshStatus, last_completed_refresh_token AS lastCompletedRefreshToken FROM app.project_mart_refresh_state WHERE project_id = 'project-recover'",
  ) as Array<{lastCompletedRefreshToken: string; refreshStatus: string}>

  expect(state).toEqual({lastCompletedRefreshToken: '1', refreshStatus: 'idle'})
})

test('runProjectMartLargeRebuildCycle CLI advances one staged batch with conservative default batch size', () => {
  const duckdbPath = join(projectRoot, '.tmp', 'run-project-mart-large-rebuild-cli.duckdb')
  removeFileIfExists(dirname(duckdbPath))
  seedDatabase({dirtyArticleCount: 1, duckdbPath, projectId: 'project-large-rebuild-cli', refreshStatus: 'idle'})

  const seedLargeRebuild = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
        const database = getAppDatabaseService()
        await database.run(\`
          UPDATE app.project_mart_refresh_state
          SET dirty_token = 0, last_completed_refresh_token = 0, active_refresh_token = 0, refresh_status = 'idle'
          WHERE project_id = 'project-large-rebuild-cli';
          DELETE FROM app.project_mart_refresh_article_state WHERE project_id = 'project-large-rebuild-cli';
        \`)
        await database.run(\`
          INSERT INTO app.prompt (id, original_text, content_hash)
          VALUES ('prompt-large-rebuild-cli', 'Prompt large rebuild cli', 'hash-large-rebuild-cli')
        \`)
        await database.run(\`
          INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled)
          VALUES ('project-prompt-large-rebuild-cli', 'project-large-rebuild-cli', 'prompt-large-rebuild-cli', 1, TRUE)
        \`)
        await database.run(\`
          INSERT INTO mart.project_scope_article (
            project_id,
            article_id,
            in_curated_scope,
            in_route_scope,
            article_created_at,
            article_updated_at
          ) VALUES (
            'project-large-rebuild-cli',
            'article-1',
            TRUE,
            FALSE,
            TIMESTAMPTZ '2026-04-01T00:00:00.000Z',
            TIMESTAMPTZ '2026-04-01T01:00:00.000Z'
          )
        \`)
        await database.run(\`
          INSERT INTO mart.judgment_fact (
            judgment_id,
            article_id,
            prompt_id,
            model_id,
            project_id,
            snapshot_project_id,
            snapshot_project_model_name,
            use_title,
            use_abstract,
            use_fulltext,
            use_fulltext_no_images,
            chunking_strategy,
            is_answered,
            answered_original,
            answered_original_as_array,
            normalized_answers,
            confidence_original,
            explanation,
            quotes,
            article_title,
            article_created_at,
            article_updated_at,
            article_import_route,
            article_publication_status,
            created_at,
            updated_at
          ) VALUES (
            'judgment-large-rebuild-cli',
            'article-1',
            'prompt-large-rebuild-cli',
            'model-project-large-rebuild-cli',
            'project-large-rebuild-cli',
            'project-large-rebuild-cli',
            'Project project-large-rebuild-cli',
            TRUE,
            TRUE,
            FALSE,
            FALSE,
            NULL,
            TRUE,
            'yes',
            ['yes'],
            ['yes'],
            1,
            NULL,
            NULL,
            'Article 1',
            TIMESTAMPTZ '2026-04-01T00:00:00.000Z',
            TIMESTAMPTZ '2026-04-01T01:00:00.000Z',
            NULL,
            NULL,
            TIMESTAMPTZ '2026-04-03T00:00:00.000Z',
            TIMESTAMPTZ '2026-04-03T00:00:00.000Z'
          )
        \`)
        await database.run(\`
          INSERT INTO app.project_mart_large_rebuild_state (
            project_id,
            refresh_token,
            rebuild_phase,
            refresh_status
          ) VALUES (
            'project-large-rebuild-cli',
            5,
            'prompt_answer_fact',
            'idle'
          )
        \`)
        await database.close()
      `,
    ],
    {cwd: projectRoot, env: {...defaultEnv, DUCKDB_PATH: duckdbPath}},
  )

  if (seedLargeRebuild.exitCode !== 0) {
    throw new Error(
      seedLargeRebuild.stderr.toString() || seedLargeRebuild.stdout.toString() || 'large rebuild cli seed failed',
    )
  }

  const runScript = globalThis.Bun.spawnSync(
    ['bun', 'scripts/runProjectMartLargeRebuildCycle.ts', '--worker-id=test-large-rebuild-cli'],
    {cwd: projectRoot, env: {...defaultEnv, DUCKDB_PATH: duckdbPath, SERVER_ROLE: 'writer', SERVER_WRITER_URL: ''}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(runScript.stderr.toString() || runScript.stdout.toString() || 'large rebuild cli run failed')
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    articleCount: number
    nextCursor: {articleCreatedAt: string; articleId: string} | null
    projectId: string
    status: string
    workerId: string
  }

  expect(result.articleCount).toBe(1)
  expect(result.projectId).toBe('project-large-rebuild-cli')
  expect(result.status).toBe('progressed')
  expect(result.workerId).toBe('test-large-rebuild-cli')
  expect(result.nextCursor?.articleId).toBe('article-1')
})

test('runProjectMartLargeRebuildCycles CLI returns structured bounded multi-cycle progress summary', () => {
  const duckdbPath = join(projectRoot, '.tmp', 'run-project-mart-large-rebuild-cycles-cli.duckdb')
  removeFileIfExists(dirname(duckdbPath))
  seedDatabase({dirtyArticleCount: 1, duckdbPath, projectId: 'project-large-rebuild-cycles-cli', refreshStatus: 'idle'})

  const seedLargeRebuild = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
        const database = getAppDatabaseService()
        await database.run(\`
          UPDATE app.project_mart_refresh_state
          SET dirty_token = 0, last_completed_refresh_token = 0, active_refresh_token = 0, refresh_status = 'idle'
          WHERE project_id = 'project-large-rebuild-cycles-cli';
          DELETE FROM app.project_mart_refresh_article_state WHERE project_id = 'project-large-rebuild-cycles-cli';
        \`)
        await database.run(\`
          INSERT INTO app.prompt (id, original_text, content_hash)
          VALUES ('prompt-large-rebuild-cycles-cli', 'Prompt large rebuild cycles cli', 'hash-large-rebuild-cycles-cli')
        \`)
        await database.run(\`
          INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled)
          VALUES ('project-prompt-large-rebuild-cycles-cli', 'project-large-rebuild-cycles-cli', 'prompt-large-rebuild-cycles-cli', 1, TRUE)
        \`)
        await database.run(\`
          INSERT INTO mart.project_scope_article (
            project_id,
            article_id,
            in_curated_scope,
            in_route_scope,
            article_created_at,
            article_updated_at
          ) VALUES (
            'project-large-rebuild-cycles-cli',
            'article-1',
            TRUE,
            FALSE,
            TIMESTAMPTZ '2026-04-01T00:00:00.000Z',
            TIMESTAMPTZ '2026-04-01T01:00:00.000Z'
          )
        \`)
        await database.run(\`
          INSERT INTO mart.judgment_fact (
            judgment_id,
            article_id,
            prompt_id,
            model_id,
            project_id,
            snapshot_project_id,
            snapshot_project_model_name,
            use_title,
            use_abstract,
            use_fulltext,
            use_fulltext_no_images,
            chunking_strategy,
            is_answered,
            answered_original,
            answered_original_as_array,
            normalized_answers,
            confidence_original,
            explanation,
            quotes,
            article_title,
            article_created_at,
            article_updated_at,
            article_import_route,
            article_publication_status,
            created_at,
            updated_at
          ) VALUES (
            'judgment-large-rebuild-cycles-cli',
            'article-1',
            'prompt-large-rebuild-cycles-cli',
            'model-project-large-rebuild-cycles-cli',
            'project-large-rebuild-cycles-cli',
            'project-large-rebuild-cycles-cli',
            'Project project-large-rebuild-cycles-cli',
            TRUE,
            TRUE,
            FALSE,
            FALSE,
            NULL,
            TRUE,
            'yes',
            ['yes'],
            ['yes'],
            1,
            NULL,
            NULL,
            'Article 1',
            TIMESTAMPTZ '2026-04-01T00:00:00.000Z',
            TIMESTAMPTZ '2026-04-01T01:00:00.000Z',
            NULL,
            NULL,
            TIMESTAMPTZ '2026-04-03T00:00:00.000Z',
            TIMESTAMPTZ '2026-04-03T00:00:00.000Z'
          )
        \`)
        await database.run(\`
          INSERT INTO app.project_mart_large_rebuild_state (
            project_id,
            refresh_token,
            rebuild_phase,
            refresh_status
          ) VALUES (
            'project-large-rebuild-cycles-cli',
            5,
            'prompt_answer_fact',
            'idle'
          )
        \`)
        await database.close()
      `,
    ],
    {cwd: projectRoot, env: {...defaultEnv, DUCKDB_PATH: duckdbPath}},
  )

  if (seedLargeRebuild.exitCode !== 0) {
    throw new Error(
      seedLargeRebuild.stderr.toString()
        || seedLargeRebuild.stdout.toString()
        || 'large rebuild cycles cli seed failed',
    )
  }

  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      'scripts/runProjectMartLargeRebuildCycles.ts',
      '--worker-id=test-large-rebuild-cycles-cli',
      '--max-cycles=3',
    ],
    {cwd: projectRoot, env: {...defaultEnv, DUCKDB_PATH: duckdbPath, SERVER_ROLE: 'writer', SERVER_WRITER_URL: ''}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(runScript.stderr.toString() || runScript.stdout.toString() || 'large rebuild cycles cli run failed')
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    completedCycles: number
    cycleResults: Array<{projectId: string | null; status: string}>
    maxCycles: number
    status: string
    stopReason: string
    workerId: string
  }

  expect(result.status).toBe('completed')
  expect(result.workerId).toBe('test-large-rebuild-cycles-cli')
  expect(result.maxCycles).toBe(3)
  expect(result.completedCycles).toBe(3)
  expect(result.stopReason).toBe('max-cycles')
  expect(result.cycleResults[0]?.projectId).toBe('project-large-rebuild-cycles-cli')
})
