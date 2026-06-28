import {existsSync, rmSync} from 'node:fs'
import {dirname, join} from 'node:path'

import {expect, test} from 'bun:test'

const projectRoot = process.cwd()

const defaultEnv = {
  ...process.env,
  API_SERVER_PORT: '39215',
  RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
  RUN_SERVER_FULL_TEXT_FETCHING: 'false',
  SERVER_DUCKDB_OWNER_URL: '',
  SERVER_ROLE: 'maintenance-worker',
  VITE_PORT: '39925',
}

const removePathIfExists = (path: string) => {
  if (existsSync(path)) {
    rmSync(path, {force: true, recursive: true})
  }
}

const getLastJsonLine = (output: string) => {
  return (
    output
      .trim()
      .split(/\r?\n/)
      .map((line) => {
        return line.trim()
      })
      .filter((line) => {
        return line.startsWith('{') && line.endsWith('}')
      })
      .slice(-1)[0] ?? ''
  )
}

const getCliTestScript = (body: string) => {
  return `
    const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
    const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
    const {getProjectMartDirtyRefreshStateService} = await import('./src/server/services/projectMartDirtyRefreshStateService.ts')

    await migrateDuckdb()

    const database = getAppDatabaseService()

    await database.run(\`
      INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
      VALUES ('cli-unquarantine-connection', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
    \`)
    await database.run(\`
      INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
      VALUES ('cli-unquarantine-model', 'cli-unquarantine-connection', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
    \`)
    await database.run(\`
      INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
      VALUES ('cli-unquarantine-project', 'CLI Unquarantine Project', 'cli-unquarantine-model', TRUE, TRUE, FALSE, FALSE)
    \`)
    await database.run(\`
      INSERT INTO app.article (id, article_title)
      VALUES ('cli-unquarantine-article', 'CLI Unquarantine Article')
    \`)

    ${body}
  `
}

const runCliTestScript = <T>(body: string) => {
  const duckdbPath = join(
    projectRoot,
    '.tmp',
    `unquarantine-dirty-refresh-article-${Date.now()}-${Math.random().toString(16).slice(2)}.duckdb`,
  )

  removePathIfExists(dirname(duckdbPath))

  const result = globalThis.Bun.spawnSync(['bun', '-e', getCliTestScript(body)], {
    cwd: projectRoot,
    env: {...defaultEnv, DUCKDB_PATH: duckdbPath},
  })

  try {
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString() || result.stdout.toString() || 'unquarantine CLI test failed')
    }

    return JSON.parse(getLastJsonLine(result.stdout.toString())) as T
  } finally {
    removePathIfExists(dirname(duckdbPath))
    removePathIfExists('/tmp/duckdb-temp')
  }
}

test('unquarantine dirty-refresh article explicitly releases parked state for retry', () => {
  const result = runCliTestScript<{
    batchAfterUnquarantine: {articleIds: string[]; hasMore: boolean}
    claimAfterUnquarantine: Array<{claimedToken: number; projectId: string}>
    claimBeforeUnquarantine: Array<{projectId: string}>
    cliOutput: {articleId: string; impactedProjectIds: string[]; status: string}
    completionAfterRetry: {completedState: {lastCompletedDirtyToken: number} | null; isClaimComplete: boolean}
    quarantineRows: Array<{resolvedAt: string | null}>
    stateBeforeUnquarantine: {activeDirtyToken: number; lastCompletedDirtyToken: number; refreshStatus: string}
  }>(`
    const service = getProjectMartDirtyRefreshStateService()

    await service.markProjectsDirtyAtomically({
      now: new Date('2026-05-04T09:00:00.000Z'),
      projects: [{articleIds: ['cli-unquarantine-article'], projectId: 'cli-unquarantine-project'}],
      reason: 'cli-unquarantine-test',
    })
    await service.quarantineProjectRefreshArticle({
      articleId: 'cli-unquarantine-article',
      detectedBy: 'cli-test',
      error: 'cli native crash',
      now: new Date('2026-05-04T09:00:01.000Z'),
      projectId: 'cli-unquarantine-project',
    })
    const [initialClaim] = await service.claimDirtyProjects({
      leaseMs: 5000,
      limit: 1,
      now: new Date('2026-05-04T09:00:02.000Z'),
      workerId: 'cli-unquarantine-worker-a',
    })
    if (!initialClaim) {
      throw new Error('Expected initial dirty-refresh claim')
    }
    await service.completeDirtyArticleBatchForClaim({
      articleIds: [],
      claimedToken: initialClaim.claimedToken,
      now: new Date('2026-05-04T09:00:03.000Z'),
      projectId: initialClaim.projectId,
      workerId: initialClaim.workerId,
    })
    const [stateBeforeUnquarantine] = await database.queryJson(\`
      SELECT
        CAST(active_dirty_token AS INTEGER) AS activeDirtyToken,
        CAST(last_completed_dirty_token AS INTEGER) AS lastCompletedDirtyToken,
        refresh_status AS refreshStatus
      FROM app.project_mart_refresh_state
      WHERE project_id = 'cli-unquarantine-project'
    \`)
    const claimBeforeUnquarantine = await service.claimDirtyProjects({
      leaseMs: 5000,
      limit: 1,
      now: new Date('2026-05-04T09:00:04.000Z'),
      workerId: 'cli-unquarantine-worker-b',
    })

    await database.close()

    const cli = Bun.spawnSync([
      'bun',
      'scripts/unquarantineDirtyRefreshArticle.ts',
      '--article-id=cli-unquarantine-article',
      '--legacy-admin-ack=legacy-dirty-refresh',
    ], {
      cwd: process.cwd(),
      env: {...process.env, DUCKDB_PATH: process.env.DUCKDB_PATH, SERVER_DUCKDB_OWNER_URL: '', SERVER_ROLE: 'maintenance-worker'},
    })

    if (cli.exitCode !== 0) {
      throw new Error(cli.stderr.toString() || cli.stdout.toString() || 'unquarantine CLI failed')
    }

    const cliJsonLine = cli.stdout.toString().trim().split(/\\r?\\n/).map((line) => {
      return line.trim()
    }).filter((line) => {
      return line.startsWith('{') && line.endsWith('}')
    }).slice(-1)[0]
    if (!cliJsonLine) {
      throw new Error('Missing unquarantine CLI JSON output')
    }
    const cliOutput = JSON.parse(cliJsonLine)
    const reopenedDatabase = getAppDatabaseService()
    const claimAfterUnquarantine = await service.claimDirtyProjects({
      leaseMs: 5000,
      limit: 1,
      now: new Date('2026-05-04T09:00:05.000Z'),
      workerId: 'cli-unquarantine-worker-c',
    })
    const [retryClaim] = claimAfterUnquarantine
    if (!retryClaim) {
      throw new Error('Expected retry claim after unquarantine')
    }
    const batchAfterUnquarantine = await service.getDirtyArticleBatchForClaim({
      batchSize: 10,
      claimedToken: retryClaim.claimedToken,
      projectId: retryClaim.projectId,
      workerId: retryClaim.workerId,
    })
    const completionAfterRetry = await service.completeDirtyArticleBatchForClaim({
      articleIds: batchAfterUnquarantine.articleIds,
      claimedToken: retryClaim.claimedToken,
      now: new Date('2026-05-04T09:00:06.000Z'),
      projectId: retryClaim.projectId,
      workerId: retryClaim.workerId,
    })
    const quarantineRows = await reopenedDatabase.queryJson(\`
      SELECT resolved_at AS resolvedAt
      FROM app.project_mart_dirty_refresh_article_quarantine
      WHERE project_id = 'cli-unquarantine-project'
        AND article_id = 'cli-unquarantine-article'
      ORDER BY dirty_token ASC
    \`)

    console.log(JSON.stringify({
      batchAfterUnquarantine,
      claimAfterUnquarantine,
      claimBeforeUnquarantine,
      cliOutput,
      completionAfterRetry,
      quarantineRows,
      stateBeforeUnquarantine,
    }))
    await reopenedDatabase.close()
  `)

  expect(result.stateBeforeUnquarantine).toEqual({
    activeDirtyToken: 1,
    lastCompletedDirtyToken: 0,
    refreshStatus: 'blocked_by_quarantine',
  })
  expect(result.claimBeforeUnquarantine).toEqual([])
  expect(result.cliOutput).toEqual({
    articleId: 'cli-unquarantine-article',
    impactedProjectIds: ['cli-unquarantine-project'],
    status: 'unquarantined',
  })
  expect(result.claimAfterUnquarantine).toMatchObject([{claimedToken: 1, projectId: 'cli-unquarantine-project'}])
  expect(result.batchAfterUnquarantine).toEqual({articleIds: ['cli-unquarantine-article'], hasMore: false})
  expect(result.completionAfterRetry.isClaimComplete).toBe(true)
  expect(result.completionAfterRetry.completedState?.lastCompletedDirtyToken).toBe(1)
  expect(result.quarantineRows).toHaveLength(1)
  expect(result.quarantineRows[0]?.resolvedAt).not.toBeNull()
})

test('unquarantine dirty-refresh article blocks without legacy admin acknowledgement', () => {
  const runScript = globalThis.Bun.spawnSync(
    ['bun', 'scripts/unquarantineDirtyRefreshArticle.ts', '--article-id=unused-article'],
    {cwd: projectRoot, env: {...defaultEnv, DUCKDB_PATH: join(projectRoot, '.tmp', 'unused-unquarantine-ack.duckdb')}},
  )

  expect(runScript.exitCode).toBe(1)
  expect(JSON.parse(getLastJsonLine(runScript.stderr.toString()))).toEqual({
    command: 'unquarantineDirtyRefreshArticle',
    requiredAck: 'legacy-dirty-refresh',
    status: 'blocked_legacy_admin_ack_required',
  })
})
