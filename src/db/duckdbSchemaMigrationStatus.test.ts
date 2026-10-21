import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {DuckDBInstance} from '@duckdb/node-api'
import {expect, test} from 'bun:test'

import {
  appliedDuckdbMigrationNamesSql,
  duckdbSchemaMigrationTableCountSql,
  getDuckdbMigrationFileNames,
  getDuckdbSchemaAheadWarning,
  getDuckdbSchemaBehindMessage,
  getDuckdbSchemaMigrationStatus,
} from './duckdbSchemaMigrationStatus.ts'

test('lists only .sql migration files in name order', () => {
  const folder = mkdtempSync(join(tmpdir(), 'f1-migration-files-'))

  try {
    writeFileSync(join(folder, '0002_second.sql'), '')
    writeFileSync(join(folder, '0001_first.sql'), '')
    writeFileSync(join(folder, 'README.md'), '')

    expect(getDuckdbMigrationFileNames(folder)).toEqual(['0001_first.sql', '0002_second.sql'])
  } finally {
    rmSync(folder, {force: true, recursive: true})
  }
})

test('the repo migration list matches the migrations folder', () => {
  const migrationNames = getDuckdbMigrationFileNames()

  expect(migrationNames.length).toBeGreaterThan(0)
  expect(migrationNames[0]).toStartWith('0000_')
  expect([...migrationNames].sort()).toEqual(migrationNames)
})

test('reports repo migrations a DB has not applied as missing, in repo order', () => {
  expect(
    getDuckdbSchemaMigrationStatus({
      appliedMigrationNames: ['0001_a.sql'],
      repoMigrationNames: ['0001_a.sql', '0002_b.sql', '0003_c.sql'],
    }),
  ).toEqual({missingMigrationNames: ['0002_b.sql', '0003_c.sql'], unknownMigrationNames: []})
})

test('reports applied migrations the checkout does not know as unknown', () => {
  expect(
    getDuckdbSchemaMigrationStatus({
      appliedMigrationNames: ['0003_c.sql', '0001_a.sql', '0002_b.sql'],
      repoMigrationNames: ['0001_a.sql', '0002_b.sql'],
    }),
  ).toEqual({missingMigrationNames: [], unknownMigrationNames: ['0003_c.sql']})
})

test('a DB with every repo migration applied is neither behind nor ahead', () => {
  expect(
    getDuckdbSchemaMigrationStatus({
      appliedMigrationNames: ['0001_a.sql', '0002_b.sql'],
      repoMigrationNames: ['0001_a.sql', '0002_b.sql'],
    }),
  ).toEqual({missingMigrationNames: [], unknownMigrationNames: []})
})

test('the behind message lists 20 missing ids and counts the rest', () => {
  const migrationNames = Array.from({length: 21}, (_value, index) => {
    return `${String(index).padStart(4, '0')}_m.sql`
  })
  const message = getDuckdbSchemaBehindMessage({duckdbPath: '/data/forska.duckdb', logPrefix: '[q]', migrationNames})
  const lines = message.split('\n')

  expect(lines[0]).toBe(
    '[q] refusing to query /data/forska.duckdb: its schema is behind this checkout by 21 migration(s) it has not applied:',
  )
  expect(lines.slice(1, 21)).toEqual(
    migrationNames.slice(0, 20).map((name) => {
      return `  ${name}`
    }),
  )
  expect(lines[21]).toBe('  ... and 1 more')
  expect(lines[22]).toContain('--allow-schema-behind')
})

test('the ahead warning names the unknown migrations', () => {
  expect(
    getDuckdbSchemaAheadWarning({
      duckdbPath: '/data/forska.duckdb',
      logPrefix: '[q]',
      migrationNames: ['9999_new.sql'],
    }),
  ).toBe(
    '[q] warning: /data/forska.duckdb has 1 applied migration(s) this checkout does not have (newer code elsewhere?):\n  9999_new.sql',
  )
})

test('the tracking-table SQL reads applied names and detects a missing table', async () => {
  const duckdbInstance = await DuckDBInstance.create(':memory:')
  const connection = await duckdbInstance.connect()

  try {
    const [beforeRow] = (await connection.runAndReadAll(duckdbSchemaMigrationTableCountSql)).getRowObjectsJson()

    await connection.run('CREATE TABLE app_schema_migration (name VARCHAR PRIMARY KEY)')
    await connection.run("INSERT INTO app_schema_migration VALUES ('0002_b.sql'), ('0001_a.sql')")

    const [afterRow] = (await connection.runAndReadAll(duckdbSchemaMigrationTableCountSql)).getRowObjectsJson()
    const nameRows = (await connection.runAndReadAll(appliedDuckdbMigrationNamesSql)).getRowObjectsJson()

    expect(beforeRow).toEqual({tableCount: 0})
    expect(afterRow).toEqual({tableCount: 1})
    expect(nameRows).toEqual([{name: '0001_a.sql'}, {name: '0002_b.sql'}])
  } finally {
    connection.closeSync()
    duckdbInstance.closeSync()
  }
})
