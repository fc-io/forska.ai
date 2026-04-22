import {existsSync, rmSync} from 'node:fs'
import {join} from 'node:path'

import {DuckDBInstance} from '@duckdb/node-api'
import {expect, test} from 'bun:test'

const projectRoot = process.cwd()
const recoveryScriptPath = join(projectRoot, 'scripts/recoverArchivedProjectRefreshQueue.ts')
const defaultEnv = {
  ...process.env,
  API_SERVER_PORT: '39001',
  RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
  RUN_SERVER_FULL_TEXT_FETCHING: 'false',
  SERVER_ROLE: 'maintenance-worker',
  VITE_PORT: '39901',
}

type RecoveryScriptResult = {
  apply: boolean
  archivedProjectsNeedingRecoveryAfter: Array<{
    lingeringMartRowCount: number
    lingeringTableCount: number
    projectId: string
    projectName: string
  }>
  archivedProjectsNeedingRecoveryBefore: Array<{
    lingeringMartRowCount: number
    lingeringTableCount: number
    projectId: string
    projectName: string
  }>
  completedTaskCount: number
  projectId: string | null
  projectMartRowsAfter: Array<{rowCount: number; tableName: string}>
  projectMartRowsBefore: Array<{rowCount: number; tableName: string}>
}

const removeFileIfExists = (filePath: string) => {
  if (existsSync(filePath)) {
    rmSync(filePath, {force: true, recursive: true})
  }
}

const seedRecoverySql = `
  INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
  VALUES ('connection-archive-recovery-test', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1');

  INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
  VALUES ('model-archive-recovery-test', 'connection-archive-recovery-test', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE);

  INSERT INTO app.project (id, name, archived, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
  VALUES
    ('project-archive-recovery-target', 'Archived Recovery Target', TRUE, 'model-archive-recovery-test', TRUE, TRUE, FALSE, FALSE),
    ('project-archive-recovery-other', 'Archived Recovery Other', TRUE, 'model-archive-recovery-test', TRUE, TRUE, FALSE, FALSE);

  INSERT INTO mart.review_article_serving (
    project_id,
    generation,
    article_id,
    article_created_at,
    article_updated_at,
    article_title,
    article_external_id,
    journal_title,
    url,
    full_text_pdf,
    full_text_fetched_at,
    full_text_conversion_status,
    source_metadata,
    has_all_llm_judgments,
    llm_judged_prompt_count,
    llm_judged_prompt_ids,
    enabled_prompt_count,
    human_answered_prompt_count,
    human_answered_prompt_ids,
    has_all_human_answers,
    review_opened,
    review_sections_completed,
    latest_llm_created_at,
    latest_human_updated_at,
    latest_review_updated_at,
    serving_updated_at
  )
  VALUES (
    'project-archive-recovery-target',
    1,
    'article-archive-recovery-target',
    TIMESTAMPTZ '2026-03-01T00:00:00.000Z',
    TIMESTAMPTZ '2026-03-01T00:00:00.000Z',
    'Archived Recovery Article',
    'EXT-ARCHIVE-RECOVERY',
    'Journal of Recovery',
    'https://example.com/archive-recovery',
    NULL,
    NULL,
    NULL,
    '{"kind":"archive-recovery"}',
    TRUE,
    1,
    ['prompt-archive-recovery'],
    1,
    0,
    NULL,
    FALSE,
    FALSE,
    0,
    NULL,
    NULL,
    NULL,
    TIMESTAMPTZ '2026-03-01T00:00:00.000Z'
  );

  INSERT INTO mart.review_article_serving (
    project_id,
    generation,
    article_id,
    article_created_at,
    article_updated_at,
    article_title,
    article_external_id,
    journal_title,
    url,
    full_text_pdf,
    full_text_fetched_at,
    full_text_conversion_status,
    source_metadata,
    has_all_llm_judgments,
    llm_judged_prompt_count,
    llm_judged_prompt_ids,
    enabled_prompt_count,
    human_answered_prompt_count,
    human_answered_prompt_ids,
    has_all_human_answers,
    review_opened,
    review_sections_completed,
    latest_llm_created_at,
    latest_human_updated_at,
    latest_review_updated_at,
    serving_updated_at
  )
  VALUES (
    'project-archive-recovery-other',
    1,
    'article-archive-recovery-other',
    TIMESTAMPTZ '2026-03-02T00:00:00.000Z',
    TIMESTAMPTZ '2026-03-02T00:00:00.000Z',
    'Archived Recovery Other Article',
    'EXT-ARCHIVE-OTHER',
    'Journal of Recovery',
    'https://example.com/archive-recovery-other',
    NULL,
    NULL,
    NULL,
    '{"kind":"archive-recovery-other"}',
    TRUE,
    1,
    ['prompt-archive-recovery'],
    1,
    0,
    NULL,
    FALSE,
    FALSE,
    0,
    NULL,
    NULL,
    NULL,
    TIMESTAMPTZ '2026-03-02T00:00:00.000Z'
  );

  INSERT INTO mart.review_article_serving_detail (
    project_id,
    generation,
    article_id,
    prompt_id,
    prompt_order,
    judgment_id,
    created_at,
    article_created_at,
    article_updated_at,
    model_id,
    answered_original,
    answered_original_as_array,
    detail_updated_at
  )
  VALUES (
    'project-archive-recovery-target',
    1,
    'article-archive-recovery-target',
    'prompt-archive-recovery',
    1,
    'judgment-archive-recovery',
    TIMESTAMPTZ '2026-03-01T00:00:00.000Z',
    TIMESTAMPTZ '2026-03-01T00:00:00.000Z',
    TIMESTAMPTZ '2026-03-01T00:00:00.000Z',
    'model-archive-recovery-test',
    'keep',
    ['keep'],
    TIMESTAMPTZ '2026-03-01T00:00:00.000Z'
  );

  INSERT INTO mart.project_scope_article (project_id, article_id, in_curated_scope, in_route_scope, article_created_at, article_updated_at)
  VALUES ('project-archive-recovery-target', 'article-archive-recovery-target', TRUE, FALSE, TIMESTAMPTZ '2026-03-01T00:00:00.000Z', TIMESTAMPTZ '2026-03-01T00:00:00.000Z');

  INSERT INTO app.review_answer_dictionary (project_id, prompt_id, answer_id, answer_value, numeric_answer_value, dictionary_updated_at)
  VALUES ('project-archive-recovery-target', 'prompt-archive-recovery', 1, 'keep', NULL, TIMESTAMPTZ '2026-03-01T00:00:00.000Z');

  INSERT INTO app.project_review_serving_generation (project_id, active_generation, generation_updated_at)
  VALUES ('project-archive-recovery-target', 1, TIMESTAMPTZ '2026-03-01T00:00:00.000Z');
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
    throw new Error(result.stderr.toString() || result.stdout.toString() || 'Archive recovery seed failed')
  }
}

const runRecoveryScript = (duckdbPath: string, args: string[]) => {
  const result = globalThis.Bun.spawnSync(['bun', recoveryScriptPath, ...args], {
    cwd: projectRoot,
    env: {...defaultEnv, DUCKDB_PATH: duckdbPath},
  })

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || result.stdout.toString() || 'Archive recovery script failed')
  }

  return JSON.parse(result.stdout.toString()) as RecoveryScriptResult
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

test('archived refresh recovery script inspects and repairs lingering archived mart rows without touching unrelated archived rows', async () => {
  const duckdbPath = `/tmp/f1-archive-refresh-recovery-${Date.now()}.duckdb`

  try {
    seedRecoveryDatabase(duckdbPath)

    const inspectResult = runRecoveryScript(duckdbPath, ['--project-id=project-archive-recovery-target'])
    const applyResult = runRecoveryScript(duckdbPath, ['--project-id=project-archive-recovery-target', '--apply'])
    const [queueSummary] = await queryDuckdbJson<{
      otherArchivedServingRows: number | string
      targetServingRows: number | string
    }>(
      duckdbPath,
      `
        SELECT
          (SELECT COUNT(*) FROM mart.review_article_serving WHERE project_id = 'project-archive-recovery-target') AS targetServingRows,
          (SELECT COUNT(*) FROM mart.review_article_serving WHERE project_id = 'project-archive-recovery-other') AS otherArchivedServingRows
      `,
    )

    expect(inspectResult.apply).toBe(false)
    expect(inspectResult.projectId).toBe('project-archive-recovery-target')
    expect(inspectResult.archivedProjectsNeedingRecoveryBefore).toHaveLength(1)
    expect(inspectResult.archivedProjectsNeedingRecoveryAfter).toHaveLength(1)
    expect(inspectResult.archivedProjectsNeedingRecoveryBefore[0]?.lingeringMartRowCount).toBe(5)
    expect(
      inspectResult.projectMartRowsBefore.some((row) => {
        return row.tableName === 'mart.review_article_serving' && Number(row.rowCount) === 1
      }),
    ).toBe(true)

    expect(applyResult.apply).toBe(true)
    expect(applyResult.projectId).toBe('project-archive-recovery-target')
    expect(applyResult.completedTaskCount).toBe(1)
    expect(applyResult.archivedProjectsNeedingRecoveryBefore).toHaveLength(1)
    expect(applyResult.archivedProjectsNeedingRecoveryAfter).toHaveLength(0)
    expect(
      applyResult.projectMartRowsAfter.every((row) => {
        return Number(row.rowCount) === 0
      }),
    ).toBe(true)
    expect(Number(queueSummary?.targetServingRows ?? 0)).toBe(0)
    expect(Number(queueSummary?.otherArchivedServingRows ?? 0)).toBe(1)
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})
