import {join} from 'node:path'

import {expect, test} from 'bun:test'

import {getRuntimeProfileDuckdbPath} from '../../utils/runtimeProfile.ts'
import {getOperatorScriptDuckdbBanner, getOperatorScriptDuckdbTarget} from './operatorScriptDuckdbTarget.ts'

const cwd = '/repo/forska'
const scriptPath = join(cwd, 'scripts', 'dbQuerySnapshot.ts')
const localDefaultPath = '/Users/tester/Library/Application Support/Forska/forska.duckdb'

test('refuses an operator script when neither FORSKA_RUNTIME_PROFILE nor DUCKDB_PATH is set', () => {
  const envValues = {HOME: '/Users/tester'}
  const target = getOperatorScriptDuckdbTarget({cwd, duckdbPath: localDefaultPath, envValues, scriptPath})

  expect(target.status).toBe('refused')

  const message = target.status === 'refused' ? target.message : ''

  expect(message.split('\n')[0]).toBe(
    '[dbQuerySnapshot] refusing to open DuckDB: FORSKA_RUNTIME_PROFILE is not set, so DUCKDB_PATH resolves to the local default',
  )
  expect(message).toContain(`  ${localDefaultPath}\n`)
  expect(message).toContain(getRuntimeProfileDuckdbPath({envValues, profileName: 'primary'}))
  expect(message).toContain(
    '  bun scripts/runWithRuntimeProfile.ts --profile primary|secondary --mode script -- bun scripts/dbQuerySnapshot.ts ...',
  )
  expect(message).toContain('  FORSKA_RUNTIME_PROFILE=local|primary|secondary bun scripts/dbQuerySnapshot.ts ...')
})

test('treats blank FORSKA_RUNTIME_PROFILE and DUCKDB_PATH values as unset', () => {
  const target = getOperatorScriptDuckdbTarget({
    cwd,
    duckdbPath: localDefaultPath,
    envValues: {DUCKDB_PATH: ' ', FORSKA_RUNTIME_PROFILE: ''},
    scriptPath,
  })

  expect(target.status).toBe('refused')
})

test('allows the local default only when FORSKA_RUNTIME_PROFILE=local is explicit', () => {
  expect(
    getOperatorScriptDuckdbTarget({
      cwd,
      duckdbPath: localDefaultPath,
      envValues: {FORSKA_RUNTIME_PROFILE: 'local'},
      scriptPath,
    }),
  ).toEqual({banner: `[dbQuerySnapshot] duckdb path: ${localDefaultPath} profile: local`, status: 'allowed'})
})

test('allows an explicit primary or secondary profile and names it in the banner', () => {
  const primaryPath = '/Users/tester/Library/Application Support/Forska/runtime/primary/forska.duckdb'

  expect(
    getOperatorScriptDuckdbTarget({
      cwd,
      duckdbPath: primaryPath,
      envValues: {FORSKA_RUNTIME_PROFILE: 'primary'},
      scriptPath,
    }),
  ).toEqual({banner: `[dbQuerySnapshot] duckdb path: ${primaryPath} profile: primary`, status: 'allowed'})
  expect(
    getOperatorScriptDuckdbTarget({
      cwd,
      duckdbPath: '/data/secondary.duckdb',
      envValues: {FORSKA_RUNTIME_PROFILE: ' Secondary '},
      scriptPath,
    }),
  ).toEqual({banner: '[dbQuerySnapshot] duckdb path: /data/secondary.duckdb profile: secondary', status: 'allowed'})
})

test('an explicit DUCKDB_PATH or DUCKDB_PATH_FILE counts as a choice without a profile', () => {
  const banner = '[dbQuerySnapshot] duckdb path: /tmp/copy.duckdb profile: unset (DUCKDB_PATH set explicitly)'

  expect(
    getOperatorScriptDuckdbTarget({
      cwd,
      duckdbPath: '/tmp/copy.duckdb',
      envValues: {DUCKDB_PATH: '/tmp/copy.duckdb'},
      scriptPath,
    }),
  ).toEqual({banner, status: 'allowed'})
  expect(
    getOperatorScriptDuckdbTarget({
      cwd,
      duckdbPath: '/tmp/copy.duckdb',
      envValues: {DUCKDB_PATH_FILE: '/run/secrets/duckdb_path'},
      scriptPath,
    }),
  ).toEqual({banner, status: 'allowed'})
})

test('refuses an unknown runtime profile name', () => {
  expect(
    getOperatorScriptDuckdbTarget({
      cwd,
      duckdbPath: localDefaultPath,
      envValues: {DUCKDB_PATH: '/tmp/copy.duckdb', FORSKA_RUNTIME_PROFILE: 'prod'},
      scriptPath,
    }),
  ).toEqual({
    message:
      '[dbQuerySnapshot] refusing to open DuckDB: FORSKA_RUNTIME_PROFILE=prod is not local, primary or secondary.',
    status: 'refused',
  })
})

test('names inline commands without a script path', () => {
  const target = getOperatorScriptDuckdbTarget({cwd, duckdbPath: localDefaultPath, envValues: {}, scriptPath: null})
  const message = target.status === 'refused' ? target.message : ''

  expect(message.startsWith('[duckdb-script] refusing to open DuckDB')).toBe(true)
  expect(message).toContain('FORSKA_RUNTIME_PROFILE=local|primary|secondary bun <script> ...')
})

test('formats the banner in the migration "duckdb path:" style', () => {
  expect(
    getOperatorScriptDuckdbBanner({duckdbPath: '/data/forska.duckdb', profileName: 'primary', scriptName: 'dbBackup'}),
  ).toBe('[dbBackup] duckdb path: /data/forska.duckdb profile: primary')
})
