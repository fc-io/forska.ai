import {mkdtempSync, readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'

import {expect} from 'bun:test'

import {duckdbEngineCompatibilityOptions, duckdbExpectedEngineIdentity} from '../../utils/duckdbEngineContract.ts'

export const verifyPersistedConflictReplacement = (input: {
  deleteStatement: string
  insertStatement: string
  expectedValue: string
}) => {
  const root = mkdtempSync(join(tmpdir(), 'forska-conflict-persisted-replace-'))
  const databasePath = join(root, 'conflict.duckdb')
  const migration = readFileSync(
    resolve(import.meta.dir, '../../../db/duckdbMigrations/0080_dropComparisonProjectChildParentForeignKeys.sql'),
    'utf8',
  )
  const noIndexMigration = readFileSync(
    resolve(import.meta.dir, '../../../db/duckdbMigrations/0230_rebuildComparisonConflictResolutionWithoutIndexes.sql'),
    'utf8',
  )
  const tableSql = migration.match(/CREATE TABLE app\.comparison_project_conflict_resolution \([\s\S]*?\n\);/)?.[0]
  expect(tableSql).toBeDefined()
  const initializerPath = resolve(import.meta.dir, '../../utils/createDuckdbInstance.ts')
  const run = (script: string) => {
    const result = globalThis.Bun.spawnSync(
      [
        process.execPath,
        '-e',
        `
      const {DuckDBInstance} = await import('@duckdb/node-api')
      const {createDuckdbInstance} = await import(${JSON.stringify(initializerPath)})
      const db = await createDuckdbInstance({create: DuckDBInstance.create.bind(DuckDBInstance), databasePath: ${JSON.stringify(databasePath)}, options: {...${JSON.stringify(duckdbEngineCompatibilityOptions)}, memory_limit: '256MiB'}, expectedEngine: ${JSON.stringify(duckdbExpectedEngineIdentity)}})
      const connection = await db.connect()
      try {${script}} finally {connection.closeSync();db.closeSync()}
    `,
      ],
      {cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe', timeout: 30_000},
    )
    expect(result.exitCode, result.stderr.toString() || result.stdout.toString()).toBe(0)
    expect(result.stderr.toString()).not.toContain('recover')
    return JSON.parse(result.stdout.toString().trim().split('\n').at(-1) ?? '{}') as {
      deleted: {articleId: string}[]
      duplicateError: string
      rows: {article_id: string; answer_value: string | null; prompt_id: string | null}[]
      constraints: {constraint_type: string}[]
      indexes: {index_name: string}[]
    }
  }
  try {
    run(`
      await connection.run("CREATE SCHEMA app; CREATE TABLE app.article(id VARCHAR PRIMARY KEY); CREATE TABLE app.prompt(id VARCHAR PRIMARY KEY); INSERT INTO app.article VALUES ('article-1'),('article-2'); INSERT INTO app.prompt VALUES ('prompt-1'),('prompt-2')")
      await connection.run(${JSON.stringify(tableSql)})
      await connection.run("ALTER TABLE app.comparison_project_conflict_resolution ADD COLUMN reviewer_user_id VARCHAR; CREATE INDEX idx_app_comparison_project_conflict_resolution_lookup ON app.comparison_project_conflict_resolution(comparison_project_id, article_id)")
      await connection.run("INSERT INTO app.comparison_project_conflict_resolution(id, comparison_project_id, article_id, answer_value) VALUES ('old-one','comparison-project-1','article-1','maybe'),('other-two','comparison-project-1','article-2','no'); CHECKPOINT")
      await connection.run(${JSON.stringify(noIndexMigration)})
      await connection.run('CHECKPOINT')
      console.log('{}')
    `)
    const mutation = run(`
      await connection.run('BEGIN')
      const deleted = (await connection.runAndReadAll(${JSON.stringify(input.deleteStatement)})).getRowObjectsJson()
      await connection.run(${JSON.stringify(input.insertStatement)})
      await connection.run('COMMIT')
      await connection.run('BEGIN')
      await connection.run(${JSON.stringify(input.deleteStatement)})
      await connection.run('ROLLBACK')
      await connection.run('CHECKPOINT')
      console.log(JSON.stringify({deleted}))
    `)
    expect(mutation.deleted).toEqual([{articleId: 'article-1'}])
    const result = run(`
      const rows = (await connection.runAndReadAll('SELECT article_id, answer_value, prompt_id FROM app.comparison_project_conflict_resolution ORDER BY article_id')).getRowObjectsJson()
      const constraints = (await connection.runAndReadAll("SELECT constraint_type FROM duckdb_constraints() WHERE schema_name='app' AND table_name='comparison_project_conflict_resolution' AND constraint_type IN ('PRIMARY KEY','UNIQUE') ORDER BY constraint_type")).getRowObjectsJson()
      const indexes = (await connection.runAndReadAll("SELECT index_name FROM duckdb_indexes() WHERE schema_name='app' AND table_name='comparison_project_conflict_resolution' ORDER BY index_name")).getRowObjectsJson()
      console.log(JSON.stringify({rows, constraints, indexes}))
    `)
    expect(result.rows).toHaveLength(2)
    expect(result.rows[0]?.answer_value ?? result.rows[0]?.prompt_id).toBe(input.expectedValue)
    expect(result.rows[1]).toEqual({article_id: 'article-2', answer_value: 'no', prompt_id: null})
    expect(result.constraints).toEqual([])
    expect(result.indexes).toEqual([])
  } finally {
    rmSync(root, {recursive: true, force: true})
  }
}
