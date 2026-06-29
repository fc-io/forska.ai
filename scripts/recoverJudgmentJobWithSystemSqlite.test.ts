import {existsSync, mkdirSync, rmSync} from 'node:fs'
import {dirname, join} from 'node:path'

import {Database} from 'bun:sqlite'
import {DuckDBInstance} from '@duckdb/node-api'
import {expect, test} from 'bun:test'

const projectRoot = process.cwd()
const defaultEnv = {
  ...process.env,
  API_SERVER_PORT: '39002',
  RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
  RUN_SERVER_FULL_TEXT_FETCHING: 'false',
  SERVER_ROLE: 'maintenance-worker',
  VITE_PORT: '39902',
}

const recoveryScriptPath = join(projectRoot, 'scripts/recoverJudgmentJobWithSystemSqlite.ts')
const sqlImportRecoveryScriptPath = join(projectRoot, 'scripts/recoverJudgmentJobWithSystemSqliteSqlImport.ts')

type ScriptResult = {
  error?: string
  status: 'failed' | 'ok' | 'partial'
  summary?: {fullyRecovered: boolean; importedRows: number; remainingOutboxRows: number; remainingQueueRows: number}
}

const removeFileIfExists = (filePath: string) => {
  if (existsSync(filePath)) {
    rmSync(filePath, {force: true, recursive: true})
  }
}

const seedRecoverySql = `
  INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
  VALUES ('connection-sqlite-recovery-test', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1');

  INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
  VALUES ('model-sqlite-recovery-test', 'connection-sqlite-recovery-test', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE);

  INSERT INTO app.project (id, name, archived, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
  VALUES ('project-sqlite-recovery-test', 'SQLite Recovery Project', FALSE, 'model-sqlite-recovery-test', TRUE, TRUE, FALSE, FALSE);

  INSERT INTO app.article (id, article_title, article_created_at, article_updated_at)
  VALUES ('article-sqlite-recovery-test', 'SQLite Recovery Article', TIMESTAMPTZ '2026-03-10T00:00:00.000Z', TIMESTAMPTZ '2026-03-10T00:00:00.000Z');

  INSERT INTO app.prompt (id, original_text, content_hash)
  VALUES ('prompt-sqlite-recovery-test', 'Should recover?', 'prompt-sqlite-recovery-test-hash');

  INSERT INTO app.project_article (id, project_id, article_id)
  VALUES ('project-article-sqlite-recovery-test', 'project-sqlite-recovery-test', 'article-sqlite-recovery-test');

  INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled)
  VALUES ('project-prompt-sqlite-recovery-test', 'project-sqlite-recovery-test', 'prompt-sqlite-recovery-test', 1, TRUE);

  INSERT INTO app.judgment_job (id, project_id, status, storage_state)
  VALUES ('job-sqlite-recovery-test', 'project-sqlite-recovery-test', 'failed', 'quarantined');
`

const seedRecoveryDatabase = (duckdbPath: string) => {
  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
        const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')

        await migrateDuckdb()
        const database = getAppDatabaseService()
        await database.run(${JSON.stringify(seedRecoverySql)})
        await database.close()
      `,
    ],
    {cwd: projectRoot, env: {...defaultEnv, DUCKDB_PATH: duckdbPath}},
  )

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || result.stdout.toString() || 'SQLite recovery seed failed')
  }
}

const seedJobSqliteDatabase = (duckdbPath: string, jobId: string) => {
  const sqlitePath = join(dirname(duckdbPath), 'judgment-jobs', `${jobId}.sqlite`)
  mkdirSync(dirname(sqlitePath), {recursive: true})
  const database = new Database(sqlitePath)
  const createdAt = '2026-03-10T00:00:00.000Z'

  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE job_info (
      job_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      model_name TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      use_title INTEGER NOT NULL,
      use_abstract INTEGER NOT NULL,
      use_fulltext INTEGER NOT NULL,
      use_fulltext_no_images INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE job_scan_state (
      job_id TEXT PRIMARY KEY,
      cursor_last_date TEXT,
      cursor_last_article_id TEXT,
      scan_epoch INTEGER NOT NULL DEFAULT 0,
      exhausted_at TEXT,
      last_project_refresh_ack_token INTEGER,
      wrap_visibility_ack_token INTEGER,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE queue_prompt (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      article_id TEXT NOT NULL,
      prompt_id TEXT NOT NULL,
      status TEXT NOT NULL,
      terminal_kind TEXT,
      skip_reason TEXT,
      server_id TEXT,
      claim_id TEXT,
      sent_at TEXT,
      judged_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(job_id, article_id, prompt_id)
    );
    CREATE TABLE judgment_outbox (
      outbox_seq INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      queue_prompt_id TEXT NOT NULL UNIQUE,
      judgment_id TEXT NOT NULL UNIQUE,
      article_id TEXT NOT NULL,
      prompt_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      project_id TEXT,
      snapshot_project_id TEXT,
      snapshot_project_model_name TEXT,
      use_title INTEGER NOT NULL,
      use_abstract INTEGER NOT NULL,
      use_fulltext INTEGER NOT NULL,
      use_fulltext_no_images INTEGER NOT NULL,
      chunking_strategy TEXT,
      is_answered INTEGER NOT NULL,
      answered_original TEXT,
      answered_original_as_array TEXT,
      confidence_original INTEGER NOT NULL,
      explanation TEXT,
      quotes_json TEXT,
      raw_response_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      exported_at TEXT,
      export_claim_id TEXT,
      export_claimed_at TEXT,
      export_claimed_by TEXT,
      export_attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );

    INSERT INTO job_info (
      job_id,
      project_id,
      model_id,
      model_name,
      model_provider,
      use_title,
      use_abstract,
      use_fulltext,
      use_fulltext_no_images,
      created_at
    ) VALUES (
      '${jobId}',
      'project-sqlite-recovery-test',
      'model-sqlite-recovery-test',
      'Qwen 35B',
      'sglang',
      1,
      1,
      0,
      0,
      '${createdAt}'
    );

    INSERT INTO job_scan_state (job_id, updated_at)
    VALUES ('${jobId}', '${createdAt}');

    INSERT INTO queue_prompt (
      id,
      job_id,
      article_id,
      prompt_id,
      status,
      judged_at,
      created_at,
      updated_at
    ) VALUES (
      'queue-sqlite-recovery-test',
      '${jobId}',
      'article-sqlite-recovery-test',
      'prompt-sqlite-recovery-test',
      'judged',
      '${createdAt}',
      '${createdAt}',
      '${createdAt}'
    );

    INSERT INTO judgment_outbox (
      job_id,
      queue_prompt_id,
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
      confidence_original,
      explanation,
      quotes_json,
      raw_response_json,
      created_at,
      updated_at
    ) VALUES (
      '${jobId}',
      'queue-sqlite-recovery-test',
      'judgment-sqlite-recovery-test',
      'article-sqlite-recovery-test',
      'prompt-sqlite-recovery-test',
      'model-sqlite-recovery-test',
      'project-sqlite-recovery-test',
      'project-sqlite-recovery-test',
      'Qwen 35B',
      1,
      1,
      0,
      0,
      'none',
      1,
      'include',
      NULL,
      90,
      'Recovered by smoke test',
      '[]',
      '{"ok":true}',
      '${createdAt}',
      '${createdAt}'
    );
  `)

  database.close(false)
}

const runRecoveryScript = (duckdbPath: string, scriptPath: string, jobId: string) => {
  const result = globalThis.Bun.spawnSync(['bun', scriptPath, `--job-id=${jobId}`], {
    cwd: projectRoot,
    env: {...defaultEnv, DUCKDB_PATH: duckdbPath},
  })

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || result.stdout.toString() || 'SQLite recovery script failed')
  }

  return JSON.parse(result.stdout.toString()) as ScriptResult
}

const queryDuckdbJson = async <T>(duckdbPath: string, statement: string) => {
  const duckdbInstance = await DuckDBInstance.create(duckdbPath, {access_mode: 'READ_ONLY', memory_limit: '20GB'})
  const connection = await duckdbInstance.connect()

  try {
    await connection.run(`SET memory_limit = '20GB'`)
    const reader = await connection.runAndReadAll(statement)
    return reader.getRowObjectsJson() as T[]
  } finally {
    connection.closeSync()
    duckdbInstance.closeSync()
  }
}

const runSmokeTest = async (scriptPath: string) => {
  const duckdbPath = `/tmp/f1-sqlite-recovery-${Date.now()}-${Math.random().toString(36).slice(2)}.duckdb`
  const jobId = 'job-sqlite-recovery-test'
  const sqliteDir = join(dirname(duckdbPath), 'judgment-jobs')

  try {
    seedRecoveryDatabase(duckdbPath)
    seedJobSqliteDatabase(duckdbPath, jobId)

    const result = runRecoveryScript(duckdbPath, scriptPath, jobId)
    const [stateRow] = await queryDuckdbJson<{
      dirtyWorkRows: number | string
      deltaRows: number | string
      judgmentRows: number | string
    }>(
      duckdbPath,
      `
        SELECT
          (SELECT COUNT(*) FROM app.judgment WHERE id = 'judgment-sqlite-recovery-test') AS judgmentRows,
          (SELECT COUNT(*) FROM app.review_change_delta WHERE judgment_id = 'judgment-sqlite-recovery-test') AS deltaRows,
          (SELECT COUNT(*) FROM app.review_serving_dirty_work WHERE project_id = 'project-sqlite-recovery-test') AS dirtyWorkRows
      `,
    )

    const sqlitePath = join(sqliteDir, `${jobId}.sqlite`)
    const sqliteDatabase = new Database(sqlitePath, {readonly: true})
    const sqliteCounts = sqliteDatabase
      .query(
        `
        SELECT
          (SELECT COUNT(*) FROM judgment_outbox) AS outboxRows,
          (SELECT COUNT(*) FROM queue_prompt) AS queueRows
      `,
      )
      .get() as {outboxRows: number; queueRows: number}
    sqliteDatabase.close(false)

    expect(result.status).toBe('ok')
    expect(result.summary?.fullyRecovered).toBe(true)
    expect(result.summary?.importedRows).toBe(1)
    expect(Number(stateRow?.judgmentRows ?? 0)).toBe(1)
    expect(Number(stateRow?.deltaRows ?? 0)).toBe(1)
    expect(Number(stateRow?.dirtyWorkRows ?? 0)).toBe(5)
    expect(Number(sqliteCounts.outboxRows ?? 0)).toBe(0)
    expect(Number(sqliteCounts.queueRows ?? 0)).toBe(0)
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
    removeFileIfExists(sqliteDir)
  }
}

test('system sqlite recovery script creates V4 dirty work instead of writing the retired mart queue', async () => {
  await runSmokeTest(recoveryScriptPath)
})

test('system sqlite SQL import recovery script creates V4 dirty work instead of writing the retired mart queue', async () => {
  await runSmokeTest(sqlImportRecoveryScriptPath)
})
