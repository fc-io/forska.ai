import {expect, test} from 'bun:test'

import {getDuckdbPath} from './getDuckdbPath.ts'

test('defaults to the macOS Application Support DuckDB path', () => {
  const duckdbPath = getDuckdbPath({cwd: '/repo/f1', envValues: {}, homeDir: '/Users/tester', platform: 'darwin'})

  expect(duckdbPath).toBe('/Users/tester/Library/Application Support/Forska/forska.duckdb')
})

test('defaults to the Linux XDG data DuckDB path', () => {
  const duckdbPath = getDuckdbPath({
    cwd: '/repo/f1',
    envValues: {XDG_DATA_HOME: '/srv/forska-data'},
    homeDir: '/home/tester',
    platform: 'linux',
  })

  expect(duckdbPath).toBe('/srv/forska-data/forska/forska.duckdb')
})

test('defaults to the Windows Local AppData DuckDB path', () => {
  const duckdbPath = getDuckdbPath({
    cwd: 'C:\\repo\\f1',
    envValues: {LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local'},
    homeDir: 'C:\\Users\\tester',
    platform: 'win32',
  })

  expect(duckdbPath).toBe('C:\\Users\\tester\\AppData\\Local\\Forska\\forska.duckdb')
})

test('keeps an explicit repo-relative DuckDB path override', () => {
  const duckdbPath = getDuckdbPath({cwd: '/repo/f1', duckdbPath: 'data/dev.duckdb', homeDir: '/Users/tester'})

  expect(duckdbPath).toBe('/repo/f1/data/dev.duckdb')
})
