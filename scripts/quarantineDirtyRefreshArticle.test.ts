import {existsSync, rmSync} from 'node:fs'
import {dirname, join} from 'node:path'

import {expect, test} from 'bun:test'

const projectRoot = process.cwd()

const defaultEnv = {
  ...process.env,
  API_SERVER_PORT: '39214',
  RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
  RUN_SERVER_FULL_TEXT_FETCHING: 'false',
  SERVER_DUCKDB_OWNER_URL: '',
  SERVER_ROLE: 'maintenance-worker',
  VITE_PORT: '39924',
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
      VALUES ('cli-quarantine-connection', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
    \`)
    await database.run(\`
      INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
      VALUES ('cli-quarantine-model', 'cli-quarantine-connection', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
    \`)
    await database.run(\`
      INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
      VALUES
        ('cli-quarantine-project-a', 'CLI Quarantine Project A', 'cli-quarantine-model', TRUE, TRUE, FALSE, FALSE),
        ('cli-quarantine-project-b', 'CLI Quarantine Project B', 'cli-quarantine-model', TRUE, TRUE, FALSE, FALSE)
    \`)
    await database.run(\`
      INSERT INTO app.article (id, article_title)
      VALUES ('cli-quarantine-article', 'CLI Quarantine Article')
    \`)

    ${body}
  `
}

const runCliTestScript = <T>(body: string) => {
  const duckdbPath = join(
    projectRoot,
    '.tmp',
    `quarantine-dirty-refresh-article-${Date.now()}-${Math.random().toString(16).slice(2)}.duckdb`,
  )

  removePathIfExists(dirname(duckdbPath))

  const result = globalThis.Bun.spawnSync(['bun', '-e', getCliTestScript(body)], {
    cwd: projectRoot,
    env: {...defaultEnv, DUCKDB_PATH: duckdbPath},
  })

  try {
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString() || result.stdout.toString() || 'quarantine CLI test failed')
    }

    return JSON.parse(getLastJsonLine(result.stdout.toString())) as T
  } finally {
    removePathIfExists(dirname(duckdbPath))
    removePathIfExists('/tmp/duckdb-temp')
  }
}

test('quarantine dirty-refresh article reports impacted projects and preserves the ACK barrier', () => {
  const result = runCliTestScript<{
    cliOutput: {
      impactedProjectIds: string[]
      quarantineRecord: {articleId: string; dirtyToken: number; projectId: string}
      status: string
    }
    completion: {isBlockedByQuarantine: boolean; isClaimComplete: boolean}
    parkedState: {
      activeDirtyToken: number
      lastCompletedDirtyToken: number
      refreshStatus: string
    }
    quarantineRows: Array<{articleId: string; dirtyToken: number; projectId: string}>
  }>(`
    const service = getProjectMartDirtyRefreshStateService()

    await service.markProjectsDirtyAtomically({
      now: new Date('2026-05-04T08:00:00.000Z'),
      projects: [
        {articleIds: ['cli-quarantine-article'], projectId: 'cli-quarantine-project-a'},
        {articleIds: ['cli-quarantine-article'], projectId: 'cli-quarantine-project-b'},
      ],
      reason: 'cli-quarantine-test',
    })
    await database.close()

    const cli = Bun.spawnSync([
      'bun',
      'scripts/quarantineDirtyRefreshArticle.ts',
      '--article-id=cli-quarantine-article',
      '--error=cli native crash',
      '--detected-by=cli-test',
    ], {
      cwd: process.cwd(),
      env: {...process.env, DUCKDB_PATH: process.env.DUCKDB_PATH, SERVER_DUCKDB_OWNER_URL: '', SERVER_ROLE: 'maintenance-worker'},
    })

    if (cli.exitCode !== 0) {
      throw new Error(cli.stderr.toString() || cli.stdout.toString() || 'quarantine CLI failed')
    }

    const cliJsonLine = cli.stdout.toString().trim().split(/\\r?\\n/).map((line) => {
      return line.trim()
    }).filter((line) => {
      return line.startsWith('{') && line.endsWith('}')
    }).slice(-1)[0]
    if (!cliJsonLine) {
      throw new Error('Missing quarantine CLI JSON output')
    }
    const cliOutput = JSON.parse(cliJsonLine)
    const reopenedDatabase = getAppDatabaseService()
    const quarantineRows = await reopenedDatabase.queryJson(\`
      SELECT
        project_id AS projectId,
        article_id AS articleId,
        CAST(dirty_token AS INTEGER) AS dirtyToken
      FROM app.project_mart_dirty_refresh_article_quarantine
      ORDER BY project_id ASC, article_id ASC, dirty_token ASC
    \`)
    const [claim] = await service.claimDirtyProjects({
      leaseMs: 5000,
      limit: 1,
      now: new Date('2026-05-04T08:00:01.000Z'),
      workerId: 'cli-quarantine-worker',
    })
    if (!claim) {
      throw new Error('Expected quarantine-blocked claim')
    }
    const completion = await service.completeDirtyArticleBatchForClaim({
      articleIds: [],
      claimedToken: claim.claimedToken,
      now: new Date('2026-05-04T08:00:02.000Z'),
      projectId: claim.projectId,
      workerId: claim.workerId,
    })
    const [parkedState] = await reopenedDatabase.queryJson(\`
      SELECT
        CAST(active_dirty_token AS INTEGER) AS activeDirtyToken,
        CAST(last_completed_dirty_token AS INTEGER) AS lastCompletedDirtyToken,
        refresh_status AS refreshStatus
      FROM app.project_mart_refresh_state
      WHERE project_id = '\${claim.projectId}'
    \`)

    console.log(JSON.stringify({cliOutput, completion, parkedState, quarantineRows}))
    await reopenedDatabase.close()
  `)

  expect(result.cliOutput.status).toBe('quarantined')
  expect(result.cliOutput.impactedProjectIds).toEqual(['cli-quarantine-project-a', 'cli-quarantine-project-b'])
  expect(result.cliOutput.quarantineRecord).toMatchObject({
    articleId: 'cli-quarantine-article',
    dirtyToken: 1,
    projectId: 'cli-quarantine-project-a',
  })
  expect(result.quarantineRows).toEqual([
    {articleId: 'cli-quarantine-article', dirtyToken: 1, projectId: 'cli-quarantine-project-a'},
    {articleId: 'cli-quarantine-article', dirtyToken: 1, projectId: 'cli-quarantine-project-b'},
  ])
  expect(result.completion).toMatchObject({isBlockedByQuarantine: true, isClaimComplete: false})
  expect(result.parkedState).toEqual({
    activeDirtyToken: 1,
    lastCompletedDirtyToken: 0,
    refreshStatus: 'blocked_by_quarantine',
  })
})
