import {expect, test} from 'bun:test'

import {
  bunTestProcessTimeoutMs,
  getBunTestCommand,
  isIgnoredBunTestFilePath,
  normalizeBunTestFilePath,
} from './runBunTests.ts'

test('Bun test discovery normalizes Windows paths before excluding generated and dependency tests', () => {
  expect(normalizeBunTestFilePath('src\\server\\example.test.ts')).toBe('src/server/example.test.ts')
  expect(isIgnoredBunTestFilePath('node_modules\\package\\source.test.ts')).toBe(true)
  expect(isIgnoredBunTestFilePath('desktopBuild\\package\\source.test.ts')).toBe(true)
  expect(isIgnoredBunTestFilePath('src\\server\\example.test.ts')).toBe(false)
})

test('Bun test discovery bounds each file process without relaxing Bun test timeouts', () => {
  expect(bunTestProcessTimeoutMs).toBe(10 * 60_000)
  expect(getBunTestCommand(['scripts/example.test.ts'], '/repo')).toEqual([
    'bun',
    'test',
    '/repo/scripts/example.test.ts',
  ])
})
