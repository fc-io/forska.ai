import {expect, test} from 'bun:test'

import {getRuntimeProfile, getRuntimeProfileEnv, mergeRuntimeProfileEnv, runtimeProfiles} from './runtimeProfile.ts'

test('runtime profiles define primary and secondary isolated runtime roots', () => {
  expect(runtimeProfiles).toEqual({
    primary: {
      dataRoot: 'data/runtime/primary',
      env: {
        API_SERVER_PORT: '3001',
        APP_SERVER_PORT: '8080',
        BACKGROUND_MAINTENANCE_PORT: '3002',
        DUCKDB_PATH: 'data/runtime/primary/forska.duckdb',
        FORSKA_RUNTIME_PROFILE: 'primary',
        VITE_PORT: '3000',
      },
      name: 'primary',
    },
    secondary: {
      dataRoot: 'data/runtime/secondary',
      env: {
        API_SERVER_PORT: '3101',
        APP_SERVER_PORT: '8180',
        BACKGROUND_MAINTENANCE_PORT: '3102',
        DUCKDB_PATH: 'data/runtime/secondary/forska.duckdb',
        FORSKA_RUNTIME_PROFILE: 'secondary',
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
    BACKGROUND_MAINTENANCE_PORT: '3002',
    DUCKDB_PATH: 'data/runtime/primary/forska.duckdb',
    FORSKA_RUNTIME_PROFILE: 'primary',
    VITE_PORT: '3000',
  })
})

test('runtime profile env merge keeps caller env and lets caller overrides win', () => {
  expect(
    mergeRuntimeProfileEnv({
      baseEnv: {APP_SERVER_PORT: '9999', CUSTOM_FLAG: 'present', VITE_PORT: '9998'},
      overrides: {APP_SERVER_PORT: '9090'},
      profileName: 'secondary',
    }),
  ).toMatchObject({
    API_SERVER_PORT: '3101',
    APP_SERVER_PORT: '9090',
    BACKGROUND_MAINTENANCE_PORT: '3102',
    CUSTOM_FLAG: 'present',
    DUCKDB_PATH: 'data/runtime/secondary/forska.duckdb',
    FORSKA_RUNTIME_PROFILE: 'secondary',
    VITE_PORT: '3100',
  })
})
