import {resolve} from 'node:path'

import {expect, test} from 'bun:test'

import {getDesktopRuntimeConfig} from './getDesktopRuntimeConfig.ts'

test('uses the macOS application support directory by default', () => {
  const runtimeConfig = getDesktopRuntimeConfig({
    createDataRoot: false,
    envValues: {FORSKA_DESKTOP_BUN_BIN: '/usr/local/bin/bun'},
    homeDirectory: '/Users/tester',
    platform: 'darwin',
  })

  expect(runtimeConfig.dataRoot).toBe('/Users/tester/Library/Application Support/Forska/desktop')
  expect(runtimeConfig.apiOrigin).toBe('http://127.0.0.1:32101')
  expect(runtimeConfig.backendCommand[0]).toBe('/usr/local/bin/bun')
  expect(runtimeConfig.backendCommand[1]).toBe(resolve(import.meta.dir, '../server/index.ts'))
  expect(runtimeConfig.backendEnv.DUCKDB_PATH).toBe(
    '/Users/tester/Library/Application Support/Forska/desktop/forska.duckdb',
  )
  expect(runtimeConfig.backendEnv.FORSKA_RUNTIME_PROFILE).toBe('local')
  expect(runtimeConfig.backendEnv.FORSKA_RUNTIME_SERVICE).toBe('dev-single-server')
  expect(runtimeConfig.backendEnv.LOG_DIR).toBe(
    '/Users/tester/Library/Application Support/Forska/desktop/logs/runtime/local',
  )
  expect(runtimeConfig.backendEnv.SERVER_ROLE).toBe('dev-single')
  expect(runtimeConfig.backendLogPath).toBe(
    '/Users/tester/Library/Application Support/Forska/desktop/logs/runtime/local/backend.log',
  )
})

test('uses LOCALAPPDATA on Windows when it is available', () => {
  const runtimeConfig = getDesktopRuntimeConfig({
    createDataRoot: false,
    envValues: {FORSKA_DESKTOP_BUN_BIN: 'C:\\Bun\\bun.exe', LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local'},
    homeDirectory: 'C:\\Users\\tester',
    platform: 'win32',
  })

  expect(runtimeConfig.dataRoot).toBe('C:\\Users\\tester\\AppData\\Local\\Forska\\desktop')
  expect(runtimeConfig.backendCommand[0]).toBe('C:\\Bun\\bun.exe')
  expect(runtimeConfig.backendEnv.DUCKDB_PATH).toBe('C:\\Users\\tester\\AppData\\Local\\Forska\\desktop\\forska.duckdb')
  expect(runtimeConfig.backendLogPath).toBe(
    'C:\\Users\\tester\\AppData\\Local\\Forska\\desktop\\logs\\runtime\\local\\backend.log',
  )
})

test('supports desktop API port overrides', () => {
  const runtimeConfig = getDesktopRuntimeConfig({
    createDataRoot: false,
    envValues: {FORSKA_DESKTOP_API_SERVER_PORT: '32999', FORSKA_DESKTOP_BUN_BIN: '/usr/local/bin/bun'},
    homeDirectory: '/Users/tester',
    platform: 'darwin',
  })

  expect(runtimeConfig.apiOrigin).toBe('http://127.0.0.1:32999')
  expect(runtimeConfig.backendEnv.API_SERVER_PORT).toBe('32999')
  expect(runtimeConfig.windowUrl).toBe('views://mainview/index.html')
  expect(
    Buffer.from(runtimeConfig.windowPreload.replace('data:text/javascript;base64,', ''), 'base64').toString('utf8'),
  ).toContain('window.__FORSKA_DESKTOP_API_ORIGIN__ = "http://127.0.0.1:32999";')
})
