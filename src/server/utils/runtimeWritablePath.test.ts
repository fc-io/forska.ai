import {expect, test} from 'bun:test'

import {getRuntimeWritableRoot, resolveRuntimeFilePath, resolveRuntimeWritablePath} from './runtimeWritablePath.ts'

test('keeps repo cwd as the writable root outside desktop mode', () => {
  expect(getRuntimeWritableRoot({cwd: '/repo/forska', envValues: {}})).toBe('/repo/forska')
})

test('uses the DuckDB parent directory as the writable root in desktop mode', () => {
  const envValues = {
    DUCKDB_PATH: '/Users/tester/Library/Application Support/Forska/desktop/forska.duckdb',
    FORSKA_DESKTOP_MODE: 'true',
  }

  expect(getRuntimeWritableRoot({cwd: '/repo/forska', envValues})).toBe(
    '/Users/tester/Library/Application Support/Forska/desktop',
  )
  expect(resolveRuntimeWritablePath({cwd: '/repo/forska', envValues, pathValue: 'assets/article_pdfs/test.pdf'})).toBe(
    '/Users/tester/Library/Application Support/Forska/desktop/assets/article_pdfs/test.pdf',
  )
})

test('preserves absolute file paths when resolving runtime files', () => {
  expect(resolveRuntimeFilePath({pathValue: '/tmp/forska.pdf'})).toBe('/tmp/forska.pdf')
})
