import {existsSync, mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {DuckDBInstance} from '@duckdb/node-api'
import {expect, test} from 'bun:test'

import {getServingTableRemediationPath} from './reproArchivedProjectServingDelete.ts'

const projectRoot = process.cwd()

type HarnessResult = {
  batchQuery: string
  deleteAttempt: {error: string | null; ok: boolean}
  deleteStatement: string
  operations: {
    projectDelete: {
      batchQuery: string | null
      deleteAttempt: {error: string | null; ok: boolean}
      deleteStatement: string
      rowCountAfter: number | null
      rowIds: string[]
      rowSample: Array<Record<string, unknown>>
      status: string
    }
    rewriteProbe: {
      retainedRowCount: number | null
      rewriteAttempt: {error: string | null; ok: boolean}
      rewriteStatement: string
      status: string
    }
    singleRowDelete: {
      batchQuery: string
      deleteAttempt: {error: string | null; ok: boolean}
      deleteStatement: string
      rowCountAfter: number | null
      rowIds: string[]
      rowSample: Array<Record<string, unknown>>
      status: string
    }
  }
  projectId: string
  remediationPath: string
  retainedSnapshot: boolean
  rowCount: number
  rowIds: string[]
  rowSample: Array<Record<string, unknown>>
  snapshotPath: string
  status: string
  tableName: string
}

const removeFileIfExists = (filePath: string) => {
  if (existsSync(filePath)) {
    rmSync(filePath, {force: true})
  }
}

const seedArchiveServingDatabase = async (duckdbPath: string) => {
  const seedSql = `
    SET memory_limit = '20GB';
    CREATE SCHEMA IF NOT EXISTS app;
    CREATE SCHEMA IF NOT EXISTS mart;
    CREATE TABLE app.project (
      id VARCHAR PRIMARY KEY,
      archived BOOLEAN NOT NULL
    );
    CREATE TABLE mart.review_article_serving (
      project_id VARCHAR NOT NULL,
      generation BIGINT NOT NULL,
      article_id VARCHAR NOT NULL,
      article_created_at TIMESTAMPTZ,
      article_updated_at TIMESTAMPTZ,
      article_title VARCHAR NOT NULL,
      article_external_id VARCHAR,
      journal_title VARCHAR,
      url VARCHAR,
      full_text_pdf VARCHAR,
      full_text_fetched_at TIMESTAMPTZ,
      full_text_conversion_status VARCHAR,
      source_metadata JSON,
      has_all_llm_judgments BOOLEAN NOT NULL,
      llm_judged_prompt_count INTEGER NOT NULL,
      llm_judged_prompt_ids VARCHAR[],
      enabled_prompt_count INTEGER NOT NULL,
      human_answered_prompt_count INTEGER NOT NULL,
      human_answered_prompt_ids VARCHAR[],
      has_all_human_answers BOOLEAN NOT NULL,
      review_opened BOOLEAN NOT NULL,
      review_sections_completed INTEGER NOT NULL,
      latest_llm_created_at TIMESTAMPTZ,
      latest_human_updated_at TIMESTAMPTZ,
      latest_review_updated_at TIMESTAMPTZ,
      serving_updated_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY(project_id, generation, article_id)
    );
    CREATE INDEX idx_mart_review_article_serving_order
    ON mart.review_article_serving(project_id, generation, has_all_llm_judgments, article_created_at, article_id);
    INSERT INTO app.project (id, archived)
    VALUES
      ('archived-project-repro', TRUE),
      ('active-project-control', FALSE);
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
    VALUES
      (
        'archived-project-repro',
        7,
        'article-001',
        TIMESTAMPTZ '2024-02-03T04:05:06.000Z',
        TIMESTAMPTZ '2024-02-04T05:06:07.000Z',
        'Archived article',
        'EXT-001',
        'Journal of Archive Failures',
        'https://example.com/archive-article',
        's3://bucket/archive-article.pdf',
        TIMESTAMPTZ '2024-02-05T06:07:08.000Z',
        'success',
        '{"journalTitle":"Journal of Archive Failures","source":"failure-log"}',
        TRUE,
        3,
        ['prompt-a', 'prompt-b', 'prompt-c'],
        3,
        1,
        ['prompt-a'],
        FALSE,
        TRUE,
        6,
        TIMESTAMPTZ '2024-02-06T07:08:09.000Z',
        TIMESTAMPTZ '2024-02-07T08:09:10.000Z',
        TIMESTAMPTZ '2024-02-08T09:10:11.000Z',
        TIMESTAMPTZ '2024-02-09T10:11:12.000Z'
      ),
      (
        'active-project-control',
        1,
        'article-002',
        TIMESTAMPTZ '2024-03-01T00:00:00.000Z',
        TIMESTAMPTZ '2024-03-01T00:00:00.000Z',
        'Active article',
        'EXT-002',
        'Journal of Controls',
        'https://example.com/active-article',
        NULL,
        NULL,
        NULL,
        '{"journalTitle":"Journal of Controls","source":"control-row"}',
        FALSE,
        0,
        NULL,
        2,
        0,
        NULL,
        FALSE,
        FALSE,
        0,
        NULL,
        NULL,
        NULL,
        TIMESTAMPTZ '2024-03-01T00:00:00.000Z'
      );
  `
  const duckdbInstance = await DuckDBInstance.create(duckdbPath, {memory_limit: '20GB'})
  const connection = await duckdbInstance.connect()

  try {
    await connection.run(seedSql)
  } finally {
    connection.closeSync()
    duckdbInstance.closeSync()
  }
}

const runHarness = (duckdbPath: string) => {
  const result = globalThis.Bun.spawnSync(['bun', join(projectRoot, 'scripts/reproArchivedProjectServingDelete.ts')], {
    cwd: projectRoot,
    env: {
      ...process.env,
      API_SERVER_PORT: '38901',
      DUCKDB_PATH: duckdbPath,
      RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
      RUN_SERVER_FULL_TEXT_FETCHING: 'false',
      SERVER_ROLE: 'maintenance-worker',
      VITE_PORT: '39901',
    },
  })

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || result.stdout.toString() || 'Archive serving repro harness failed')
  }

  return JSON.parse(result.stdout.toString()) as HarnessResult
}

test('serving table remediation path switches to rewrite when single-row delete fails', () => {
  const remediationPath = getServingTableRemediationPath({
    projectDelete: {
      batchQuery: null,
      deleteAttempt: {error: 'project delete failed', ok: false},
      deleteStatement: 'DELETE FROM mart.review_article_serving WHERE project_id = ...',
      rowCountAfter: null,
      rowIds: [],
      rowSample: [],
      status: 'project-delete-failed',
    },
    rewriteProbe: {
      retainedRowCount: 42,
      rewriteAttempt: {error: null, ok: true},
      rewriteStatement: 'CREATE OR REPLACE TABLE mart.review_article_serving_rewrite_probe AS ...',
      status: 'rewrite-probe-succeeded',
    },
    singleRowDelete: {
      batchQuery: 'SELECT rowid AS rowId FROM mart.review_article_serving LIMIT 1',
      deleteAttempt: {error: 'single row failed', ok: false},
      deleteStatement: 'DELETE FROM mart.review_article_serving WHERE rowid IN (1)',
      rowCountAfter: null,
      rowIds: ['1'],
      rowSample: [{project_id: 'archived-project-repro'}],
      status: 'single-row-delete-failed',
    },
  })

  expect(remediationPath).toBe('rewrite-serving-table')
})

test('archive serving repro harness captures delete and rewrite probe results on repeat runs', async () => {
  const workingDirectory = mkdtempSync(join(tmpdir(), 'f1-archive-serving-repro-'))
  const duckdbPath = join(workingDirectory, 'archive-serving.duckdb')
  const normalizeTimestamp = (value: unknown) => {
    return typeof value !== 'string'
      ? value
      : new Date(value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')).toISOString()
  }
  const normalizeRowSample = (row: Record<string, unknown>) => {
    return {
      ...row,
      article_created_at: normalizeTimestamp(row.article_created_at),
      article_updated_at: normalizeTimestamp(row.article_updated_at),
      full_text_fetched_at: normalizeTimestamp(row.full_text_fetched_at),
      latest_human_updated_at: normalizeTimestamp(row.latest_human_updated_at),
      latest_llm_created_at: normalizeTimestamp(row.latest_llm_created_at),
      latest_review_updated_at: normalizeTimestamp(row.latest_review_updated_at),
      serving_updated_at: normalizeTimestamp(row.serving_updated_at),
    }
  }

  try {
    await seedArchiveServingDatabase(duckdbPath)

    const firstRun = runHarness(duckdbPath)
    const secondRun = runHarness(duckdbPath)

    expect(firstRun.projectId).toBe('archived-project-repro')
    expect(firstRun.tableName).toBe('mart.review_article_serving')
    expect(firstRun.batchQuery).toContain('LIMIT 1')
    expect(firstRun.deleteStatement).toContain('DELETE FROM mart.review_article_serving')
    expect(firstRun.deleteAttempt.ok).toBe(true)
    expect(firstRun.operations.singleRowDelete.deleteAttempt.ok).toBe(true)
    expect(firstRun.operations.singleRowDelete.rowCountAfter).toBe(0)
    expect(firstRun.operations.projectDelete.deleteAttempt.ok).toBe(true)
    expect(firstRun.operations.projectDelete.deleteStatement).toContain("WHERE project_id = 'archived-project-repro'")
    expect(firstRun.operations.projectDelete.rowCountAfter).toBe(0)
    expect(firstRun.operations.rewriteProbe.rewriteAttempt.ok).toBe(true)
    expect(firstRun.operations.rewriteProbe.rewriteStatement).toContain('CREATE OR REPLACE TABLE')
    expect(firstRun.operations.rewriteProbe.retainedRowCount).toBe(1)
    expect(firstRun.remediationPath).toBe('keep-single-row-purge')
    expect(firstRun.rowIds).toHaveLength(1)
    expect(normalizeRowSample(firstRun.rowSample[0] as Record<string, unknown>)).toEqual({
      article_created_at: '2024-02-03T04:05:06.000Z',
      article_external_id: 'EXT-001',
      article_id: 'article-001',
      article_title: 'Archived article',
      article_updated_at: '2024-02-04T05:06:07.000Z',
      enabled_prompt_count: 3,
      full_text_conversion_status: 'success',
      full_text_fetched_at: '2024-02-05T06:07:08.000Z',
      full_text_pdf: 's3://bucket/archive-article.pdf',
      generation: '7',
      has_all_human_answers: false,
      has_all_llm_judgments: true,
      human_answered_prompt_count: 1,
      human_answered_prompt_ids: ['prompt-a'],
      journal_title: 'Journal of Archive Failures',
      latest_human_updated_at: '2024-02-07T08:09:10.000Z',
      latest_llm_created_at: '2024-02-06T07:08:09.000Z',
      latest_review_updated_at: '2024-02-08T09:10:11.000Z',
      llm_judged_prompt_count: 3,
      llm_judged_prompt_ids: ['prompt-a', 'prompt-b', 'prompt-c'],
      project_id: 'archived-project-repro',
      review_opened: true,
      review_sections_completed: 6,
      rowId: firstRun.rowIds[0],
      serving_updated_at: '2024-02-09T10:11:12.000Z',
      source_metadata: '{"journalTitle":"Journal of Archive Failures","source":"failure-log"}',
      url: 'https://example.com/archive-article',
    })
    expect(secondRun.projectId).toBe('archived-project-repro')
    expect(secondRun.rowIds).toEqual(firstRun.rowIds)
    expect(secondRun.rowSample).toEqual(firstRun.rowSample)
    expect(secondRun.operations.projectDelete.rowCountAfter).toBe(firstRun.operations.projectDelete.rowCountAfter)
    expect(secondRun.operations.rewriteProbe.retainedRowCount).toBe(firstRun.operations.rewriteProbe.retainedRowCount)
    expect(existsSync(firstRun.snapshotPath)).toBe(false)
  } finally {
    rmSync(workingDirectory, {force: true, recursive: true})
    removeFileIfExists(`${duckdbPath}.wal`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})
