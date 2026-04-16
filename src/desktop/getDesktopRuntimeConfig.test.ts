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
  expect(runtimeConfig.backendEnv.DUCKDB_PATH).toBe(
    '/Users/tester/Library/Application Support/Forska/desktop/forska.duckdb',
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
  expect(runtimeConfig.windowUrl).toBe('views://mainview/index.html?apiOrigin=http%3A%2F%2F127.0.0.1%3A32999')
})
