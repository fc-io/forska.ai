import {normalize, resolve} from 'node:path'

import {expect, test} from 'bun:test'

import {getDefaultRuntimeLogDir} from './runtimeLogger.ts'
import {getRuntimeWritableRoot, resolveRuntimeFilePath, resolveRuntimeWritablePath} from './runtimeWritablePath.ts'

test('keeps the process cwd as the writable root', () => {
  expect(getRuntimeWritableRoot({cwd: '/repo/forska'})).toBe('/repo/forska')
  expect(resolveRuntimeWritablePath({cwd: '/repo/forska', pathValue: 'assets/article_pdfs/test.pdf'})).toBe(
    resolve('/repo/forska', 'assets', 'article_pdfs', 'test.pdf'),
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
