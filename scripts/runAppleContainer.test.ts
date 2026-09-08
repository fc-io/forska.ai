import {expect, test} from 'bun:test'

import {getAppleContainerCommands} from './runAppleContainer.ts'

test('validates custom host ports before starting any containers', () => {
  expect(getAppleContainerCommands({port: '65535'})[2]).toContain('127.0.0.1:65535:3000')
  for (const port of ['', '0', '65536', '-1', '3000:3001', 'abc', '3300; echo bad']) {
    expect(() => {
      return getAppleContainerCommands({port})
    }).toThrow('FORSKA_CONTAINER_PORT')
  }
})

test('uses 8 GiB by default and accepts whole GiB comparison budgets', () => {
  const defaultRun = getAppleContainerCommands()[2]
  const comparisonRun = getAppleContainerCommands({memory: '16G'})[2]
  expect(defaultRun[defaultRun.indexOf('--memory') + 1]).toBe('8G')
  expect(comparisonRun[comparisonRun.indexOf('--memory') + 1]).toBe('16G')
  for (const memory of ['', '0G', '-1G', '8', '8GB', '0.5G', '8G --privileged', '9007199254740992G']) {
    expect(() => {
      return getAppleContainerCommands({memory})
    }).toThrow('FORSKA_CONTAINER_MEMORY')
  }
})
