import {expect, test} from 'bun:test'

import {
  getLegacyRuntimeProfileDuckdbPath,
  getRuntimeProfile,
  getRuntimeProfileDataRoot,
  getRuntimeProfileDuckdbPath,
  getRuntimeProfileEnv,
  mergeRuntimeProfileEnv,
  runtimeProfiles,
} from './runtimeProfile.ts'

test('runtime profiles define primary and secondary isolated runtime roots', () => {
  const primaryDataRoot = getRuntimeProfileDataRoot({profileName: 'primary'})
  const secondaryDataRoot = getRuntimeProfileDataRoot({profileName: 'secondary'})

  expect(runtimeProfiles).toEqual({
    primary: {
      dataRoot: primaryDataRoot,
      env: {
        API_SERVER_PORT: '3001',
        APP_SERVER_PORT: '8080',
        BACKGROUND_JUDGE_PORT: '3003',
        BACKGROUND_MAINTENANCE_PORT: '3002',
        DUCKDB_PATH: getRuntimeProfileDuckdbPath({profileName: 'primary'}),
        FORSKA_RUNTIME_PROFILE: 'primary',
        JUDGE_WORKER_ID: 'primary-judge-worker',
        VITE_PORT: '3000',
      },
      name: 'primary',
    },
    secondary: {
      dataRoot: secondaryDataRoot,
      env: {
        API_SERVER_PORT: '3101',
        APP_SERVER_PORT: '8180',
        BACKGROUND_JUDGE_PORT: '3103',
        BACKGROUND_MAINTENANCE_PORT: '3102',
        DUCKDB_PATH: getRuntimeProfileDuckdbPath({profileName: 'secondary'}),
        FORSKA_RUNTIME_PROFILE: 'secondary',
        JUDGE_WORKER_ID: 'secondary-judge-worker',
        VITE_PORT: '3100',
      },
      name: 'secondary',
    },
  })
})

test('runtime profile helpers return the selected profile and env mapping', () => {
  expect(getRuntimeProfile('secondary')).toEqual(runtimeProfiles.secondary)
  expect(getRuntimeProfileEnv('primary')).toEqual({
    API_SERVER_PORT: '3001',
    APP_SERVER_PORT: '8080',
    BACKGROUND_JUDGE_PORT: '3003',
    BACKGROUND_MAINTENANCE_PORT: '3002',
    DUCKDB_PATH: getRuntimeProfileDuckdbPath({profileName: 'primary'}),
    FORSKA_RUNTIME_PROFILE: 'primary',
    JUDGE_WORKER_ID: 'primary-judge-worker',
    VITE_PORT: '3000',
  })
})

test('runtime profile DuckDB paths use platform-local app data', () => {
  expect(
    getRuntimeProfileDuckdbPath({
      envValues: {LOCALAPPDATA: 'C:\\Users\\vikto\\AppData\\Local'},
      platform: 'win32',
      profileName: 'primary',
    }),
  ).toBe('C:\\Users\\vikto\\AppData\\Local\\Forska\\runtime\\primary\\forska.duckdb')
  expect(
    getRuntimeProfileDuckdbPath({envValues: {HOME: '/Users/fredrik'}, platform: 'darwin', profileName: 'secondary'}),
  ).toBe('/Users/fredrik/Library/Application Support/Forska/runtime/secondary/forska.duckdb')
  expect(getLegacyRuntimeProfileDuckdbPath('primary')).toBe('data/runtime/primary/forska.duckdb')
})

test('runtime profile env merge keeps caller env and lets caller overrides win', () => {
  expect(
    mergeRuntimeProfileEnv({
      baseEnv: {
        APP_SERVER_PORT: '9999',
        CUSTOM_FLAG: 'present',
        HOME: '/home/test-user',
        JUDGE_WORKER_JOURNAL_PATH: 'data/custom/judge.sqlite',
        VITE_PORT: '9998',
      },
      overrides: {APP_SERVER_PORT: '9090'},
      profileName: 'secondary',
    }),
  ).toMatchObject({
    API_SERVER_PORT: '3101',
    APP_SERVER_PORT: '9090',
    BACKGROUND_JUDGE_PORT: '3103',
    BACKGROUND_MAINTENANCE_PORT: '3102',
    CUSTOM_FLAG: 'present',
    DUCKDB_PATH: getRuntimeProfileDuckdbPath({
      envValues: {...process.env, HOME: '/home/test-user'},
      profileName: 'secondary',
    }),
    FORSKA_RUNTIME_PROFILE: 'secondary',
    HOME: '/home/test-user',
    JUDGE_WORKER_ID: 'secondary-judge-worker',
    JUDGE_WORKER_JOURNAL_PATH: 'data/custom/judge.sqlite',
    VITE_PORT: '3100',
  })
})
