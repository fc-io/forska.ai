import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'

import {expect, test} from 'bun:test'

import {getJudgmentJobLeasePath, getJudgmentJobSqlitePath, getJudgmentJobsRootDirectory} from './judgmentJobPaths.ts'

test('derives native job SQLite and lease paths beside the configured DuckDB', () => {
  const root = mkdtempSync(join(tmpdir(), 'forska-judgment-job-paths-'))
  const previousDuckdbPath = process.env.DUCKDB_PATH
  const duckdbPath = join(root, 'app-data', 'forska.duckdb')

  try {
    process.env.DUCKDB_PATH = duckdbPath

    expect(getJudgmentJobsRootDirectory()).toBe(join(dirname(duckdbPath), 'judgment-jobs'))
    expect(getJudgmentJobSqlitePath('job-native')).toBe(join(dirname(duckdbPath), 'judgment-jobs', 'job-native.sqlite'))
    expect(getJudgmentJobLeasePath('job-native')).toBe(
      join(dirname(duckdbPath), 'judgment-jobs', 'job-native.lease.json'),
    )
  } finally {
    if (previousDuckdbPath === undefined) delete process.env.DUCKDB_PATH
    else process.env.DUCKDB_PATH = previousDuckdbPath
    rmSync(root, {force: true, recursive: true})
  }
})
