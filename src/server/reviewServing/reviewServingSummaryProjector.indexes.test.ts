import {existsSync, mkdtempSync, readdirSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {expect, test} from 'bun:test'

type Snapshot = {
  rows: {count_value: string}[][]
  indexes: unknown[]
  constraints: unknown[]
  columns: unknown[]
  view: unknown[]
}

type Publication = {
  diagnostics: {inputRecordCount: number; dedupedRecordCount: number}[]
  rollbackError: string | null
  beforeRollback: Snapshot
  afterRollback: Snapshot
}

const runPhase = <T>(databasePath: string, phase: string) => {
  const fixturePath = join(import.meta.dir, 'reviewServingSummaryProjector/summaryIndexFixture.ts')
  const result = globalThis.Bun.spawnSync(
    [
      process.execPath,
      '-e',
      `
    const {runSummaryIndexFixture} = await import(${JSON.stringify(fixturePath)})
    console.log(JSON.stringify(await runSummaryIndexFixture(${JSON.stringify(phase)})))
  `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DUCKDB_PATH: databasePath,
        DUCKDB_MEMORY_LIMIT: '512MiB',
        SERVER_ROLE: 'maintenance-worker',
        SERVER_DUCKDB_OWNER_URL: '',
        FORSKA_DUCKDB_STARTUP_WAL_PREFLIGHT: 'true',
      },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 120_000,
    },
  )
  const stdout = result.stdout.toString()
  const stderr = result.stderr.toString()
  expect(result.exitCode, `${phase}\n${stdout}\n${stderr}`).toBe(0)
  expect(`${stdout}\n${stderr}`).not.toMatch(
    /rebuilt indexed tables|restarting embedded runtime after fatal|marked indexed table repair/,
  )
  return JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as T
}

const expectNoIndexes = (snapshot: Snapshot) => {
  expect(snapshot.indexes).toEqual([])
  expect(snapshot.constraints).toEqual([])
}

const expectPublishedValues = (snapshot: Snapshot) => {
  expect(
    snapshot.rows.map((rows) => {
      return rows.map((row) => {
        return row.count_value
      })
    }),
  ).toEqual([
    ['32', '41', '12'],
    ['32', '41', '12'],
  ])
}

const assertPersistentPublication = (databasePath: string) => {
  const published = runPhase<Publication>(databasePath, 'publish')
  expectPublishedValues(published.afterRollback)
  expectNoIndexes(published.afterRollback)
  expect(published.afterRollback).toEqual(published.beforeRollback)
  expect(published.rollbackError).toContain('missing_summary_fixture_function')
  expect(published.diagnostics).toHaveLength(3)
  for (const diagnostics of published.diagnostics) {
    expect(diagnostics.inputRecordCount).toBe(4)
    expect(diagnostics.dedupedRecordCount).toBe(2)
  }
  const reopened = runPhase<Snapshot>(databasePath, 'inspect')
  expect(reopened).toEqual(published.afterRollback)
  const repeated = runPhase<Publication>(databasePath, 'publish')
  expect(repeated.afterRollback).toEqual(reopened)
  const recoveryPath = `${databasePath}.startup-recovery`
  const recoveryFiles = existsSync(recoveryPath) ? readdirSync(recoveryPath) : []
  expect(
    recoveryFiles.filter((name) => {
      return /recovery\.json$|pre-repair\.duckdb|startup-preflight-active-table/.test(name)
    }),
  ).toEqual([])
}

test('forward summary migration preserves rows/defaults/views and removes persisted unique indexes before repeated writer replacement', () => {
  const root = mkdtempSync(join(tmpdir(), 'forska-summary-index-upgrade-'))
  const databasePath = join(root, 'summary.duckdb')
  try {
    const seeded = runPhase<Snapshot>(databasePath, 'seed')
    expect(seeded.indexes).toHaveLength(2)
    const oldWriter = runPhase<{error: string; snapshot: Snapshot}>(databasePath, 'old-writer')
    expect(oldWriter.error).toContain('Duplicate key')
    expect(oldWriter.snapshot).toEqual(seeded)
    const upgraded = runPhase<{before: Snapshot; after: Snapshot}>(databasePath, 'upgrade')
    expect(upgraded.before).toEqual(seeded)
    expect(upgraded.after.rows).toEqual(seeded.rows)
    expect(upgraded.after.columns).toEqual(seeded.columns)
    expect(upgraded.after.view).toEqual(seeded.view)
    expectNoIndexes(upgraded.after)
    assertPersistentPublication(databasePath)
  } finally {
    rmSync(root, {recursive: true, force: true})
  }
}, 120_000)

test('owner startup preflight and migration upgrade an old indexed summary database without native recovery', () => {
  const root = mkdtempSync(join(tmpdir(), 'forska-summary-owner-upgrade-'))
  const databasePath = join(root, 'summary.duckdb')
  try {
    const seeded = runPhase<Snapshot>(databasePath, 'seed')
    expect(seeded.indexes).toHaveLength(2)
    const upgraded = runPhase<Snapshot>(databasePath, 'managed')
    expectNoIndexes(upgraded)
    expect(upgraded.columns).toEqual(seeded.columns)
    expect(
      upgraded.rows.map((rows) => {
        return rows.map((row) => {
          return row.count_value
        })
      }),
    ).toEqual([
      ['32', '11', '12'],
      ['32', '11', '12'],
    ])
    assertPersistentPublication(databasePath)
  } finally {
    rmSync(root, {recursive: true, force: true})
  }
}, 120_000)

test('fresh migrations produce index-free summary marts whose scoped writer survives checkpoint and fresh-process reopen', () => {
  const root = mkdtempSync(join(tmpdir(), 'forska-summary-fresh-indexes-'))
  const databasePath = join(root, 'summary.duckdb')
  try {
    expectNoIndexes(runPhase<Snapshot>(databasePath, 'fresh'))
    assertPersistentPublication(databasePath)
  } finally {
    rmSync(root, {recursive: true, force: true})
  }
}, 120_000)
