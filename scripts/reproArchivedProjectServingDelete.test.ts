import {existsSync, mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {DuckDBInstance} from '@duckdb/node-api'
import {expect, test} from 'bun:test'

const projectRoot = process.cwd()

type HarnessResult = {
  batchQuery: string
  deleteAttempt: {error: string | null; ok: boolean}
  deleteStatement: string
  projectId: string
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
      article_title VARCHAR NOT NULL
    );
    INSERT INTO app.project (id, archived)
    VALUES
      ('archived-project-repro', TRUE),
      ('active-project-control', FALSE);
    INSERT INTO mart.review_article_serving (project_id, generation, article_id, article_title)
    VALUES
      ('archived-project-repro', 7, 'article-001', 'Archived article'),
      ('active-project-control', 1, 'article-002', 'Active article');
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
      SERVER_ROLE: 'writer',
      VITE_PORT: '39901',
    },
  })

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || result.stdout.toString() || 'Archive serving repro harness failed')
  }

  return JSON.parse(result.stdout.toString()) as HarnessResult
}

test('archive serving repro harness captures project, table, and delete shape on repeat runs', async () => {
  const workingDirectory = mkdtempSync(join(tmpdir(), 'f1-archive-serving-repro-'))
  const duckdbPath = join(workingDirectory, 'archive-serving.duckdb')

  try {
    await seedArchiveServingDatabase(duckdbPath)

    const firstRun = runHarness(duckdbPath)
    const secondRun = runHarness(duckdbPath)

    expect(firstRun.projectId).toBe('archived-project-repro')
    expect(firstRun.tableName).toBe('mart.review_article_serving')
    expect(firstRun.batchQuery).toContain('LIMIT 1')
    expect(firstRun.deleteStatement).toContain('DELETE FROM mart.review_article_serving')
    expect(firstRun.deleteAttempt.ok).toBe(true)
    expect(firstRun.rowIds).toHaveLength(1)
    expect(firstRun.rowSample[0]?.project_id).toBe('archived-project-repro')
    expect(secondRun.projectId).toBe('archived-project-repro')
    expect(secondRun.rowIds).toEqual(firstRun.rowIds)
    expect(existsSync(firstRun.snapshotPath)).toBe(false)
  } finally {
    rmSync(workingDirectory, {force: true, recursive: true})
    removeFileIfExists(`${duckdbPath}.wal`)
    removeFileIfExists(`${duckdbPath}.writer.lock`)
    removeFileIfExists(`${duckdbPath}.writer.history.json`)
  }
})
