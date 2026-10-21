import {resolve} from 'node:path'

import {expect, test} from 'bun:test'

import {getRuntimeProfileDuckdbPath} from '../../utils/runtimeProfile.ts'
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

test('an explicit primary or secondary runtime profile selects that profile DuckDB file', () => {
  expect(
    getDuckdbPath({
      cwd: '/repo/f1',
      envValues: {FORSKA_RUNTIME_PROFILE: 'primary', HOME: '/Users/tester'},
      homeDir: '/Users/tester',
      platform: 'darwin',
    }),
  ).toBe(getRuntimeProfileDuckdbPath({envValues: {HOME: '/Users/tester'}, platform: 'darwin', profileName: 'primary'}))
  expect(
    getDuckdbPath({
      cwd: '/repo/f1',
      envValues: {FORSKA_RUNTIME_PROFILE: 'secondary', XDG_DATA_HOME: '/srv/forska-data'},
      homeDir: '/home/tester',
      platform: 'linux',
    }),
  ).toBe('/srv/forska-data/forska/runtime/secondary/forska.duckdb')
  expect(
    getDuckdbPath({
      cwd: 'C:\\repo\\f1',
      envValues: {FORSKA_RUNTIME_PROFILE: 'Primary', LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local'},
      homeDir: 'C:\\Users\\tester',
      platform: 'win32',
    }),
  ).toBe('C:\\Users\\tester\\AppData\\Local\\Forska\\runtime\\primary\\forska.duckdb')
})

test('the local runtime profile keeps the local default DuckDB file', () => {
  const duckdbPath = getDuckdbPath({
    cwd: '/repo/f1',
    envValues: {FORSKA_RUNTIME_PROFILE: 'local'},
    homeDir: '/Users/tester',
    platform: 'darwin',
  })

  expect(duckdbPath).toBe('/Users/tester/Library/Application Support/Forska/forska.duckdb')
})

test('an explicit DuckDB path wins over the runtime profile default', () => {
  const duckdbPath = getDuckdbPath({
    cwd: '/repo/f1',
    duckdbPath: '/tmp/copy.duckdb',
    envValues: {FORSKA_RUNTIME_PROFILE: 'primary'},
    homeDir: '/Users/tester',
    platform: 'darwin',
  })

  expect(duckdbPath).toBe('/tmp/copy.duckdb')
})

test('keeps an explicit repo-relative DuckDB path override', () => {
  const duckdbPath = getDuckdbPath({cwd: '/repo/f1', duckdbPath: 'data/dev.duckdb', homeDir: '/Users/tester'})

  expect(duckdbPath).toBe(resolve('/repo/f1', 'data', 'dev.duckdb'))
})
