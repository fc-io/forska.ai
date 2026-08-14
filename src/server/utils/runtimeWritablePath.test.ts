import {dirname, normalize, resolve} from 'node:path'

import {expect, test} from 'bun:test'

import {getDefaultRuntimeLogDir} from './runtimeLogger.ts'
import {getRuntimeWritableRoot, resolveRuntimeFilePath, resolveRuntimeWritablePath} from './runtimeWritablePath.ts'

test('keeps repo cwd as the writable root outside desktop mode', () => {
  expect(getRuntimeWritableRoot({cwd: '/repo/forska', envValues: {}})).toBe('/repo/forska')
})

test('uses the DuckDB parent directory as the writable root in desktop mode', () => {
  const duckdbPath = '/Users/tester/Library/Application Support/Forska/desktop/forska.duckdb'
  const envValues = {DUCKDB_PATH: duckdbPath, FORSKA_DESKTOP_MODE: 'true'}
  const writableRoot = dirname(normalize(duckdbPath))

  expect(getRuntimeWritableRoot({cwd: '/repo/forska', envValues})).toBe(writableRoot)
  expect(resolveRuntimeWritablePath({cwd: '/repo/forska', envValues, pathValue: 'assets/article_pdfs/test.pdf'})).toBe(
    resolve(writableRoot, 'assets', 'article_pdfs', 'test.pdf'),
  )
})

test('preserves absolute file paths when resolving runtime files', () => {
  expect(resolveRuntimeFilePath({pathValue: '/tmp/forska.pdf'})).toBe(normalize('/tmp/forska.pdf'))
})

test('resolves runtime log roots through the writable root', () => {
  expect(getDefaultRuntimeLogDir({cwd: '/repo/forska', envValues: {FORSKA_RUNTIME_PROFILE: 'secondary'}})).toBe(
    resolve('/repo/forska', 'logs', 'runtime', 'secondary'),
  )
})
