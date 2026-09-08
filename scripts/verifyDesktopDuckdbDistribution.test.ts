import {join} from 'node:path'

import {expect, test} from 'bun:test'

import {getDesktopDistributionRoot} from './verifyDesktopDuckdbDistribution.ts'

test('resolves the native engine inside the exact Electrobun output, including spaced names', () => {
  const env = {ELECTROBUN_BUILD_DIR: '/build/dev-target', ELECTROBUN_APP_NAME: 'Forska Test'}
  expect(getDesktopDistributionRoot({...env, ELECTROBUN_OS: 'macos'})).toBe(
    join('/build/dev-target', 'Forska Test.app', 'Contents', 'Resources', 'app'),
  )
  expect(getDesktopDistributionRoot({...env, ELECTROBUN_OS: 'win'})).toBe(
    join('/build/dev-target', 'Forska Test', 'Resources', 'app'),
  )
  expect(getDesktopDistributionRoot({...env, ELECTROBUN_OS: 'linux'})).toBe(
    join('/build/dev-target', 'Forska Test', 'Resources', 'app'),
  )
})

test('refuses an unscoped build check instead of accidentally testing checkout dependencies', () => {
  expect(() => {
    return getDesktopDistributionRoot({})
  }).toThrow('Electrobun postBuild hook')
})
