import {afterEach, expect, test} from 'bun:test'

import {getRuntimeBuildInfo} from './runtimeBuildInfo.ts'

const envCommitKeys = [
  'FORSKA_COMMIT_SHA',
  'FORSKA_GIT_SHA',
  'GIT_COMMIT',
  'GITHUB_SHA',
  'VERCEL_GIT_COMMIT_SHA',
  'COMMIT_SHA',
] as const

const originalValues = new Map<string, string | undefined>()

for (const key of envCommitKeys) {
  originalValues.set(key, process.env[key])
}

afterEach(() => {
  for (const key of envCommitKeys) {
    const originalValue = originalValues.get(key)

    if (originalValue === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = originalValue
    }
  }
})

test('runtime build info prefers explicit Forska commit env', () => {
  process.env.FORSKA_COMMIT_SHA = 'abcdef1234567890'
  process.env.GITHUB_SHA = 'ignored-github-sha'

  expect(getRuntimeBuildInfo()).toEqual({
    commitSha: 'abcdef1234567890',
    commitShaSource: 'env',
    shortCommitSha: 'abcdef123456',
  })
})

test('runtime build info ignores blank env commit values', () => {
  process.env.FORSKA_COMMIT_SHA = ' '
  process.env.GITHUB_SHA = '1234567890abcdef'

  expect(getRuntimeBuildInfo()).toEqual({
    commitSha: '1234567890abcdef',
    commitShaSource: 'env',
    shortCommitSha: '1234567890ab',
  })
})
