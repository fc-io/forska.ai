import {expect, test} from 'bun:test'

import {getClaudeCodeMaxInflight} from './getClaudeCodeMaxInflight.ts'
import {getProviderBucketSnapshot} from './providerAdmissionLease.ts'

test('getClaudeCodeMaxInflight defaults to 24 and honors FORSKA_CLAUDE_CODE_MAX_INFLIGHT', () => {
  expect(getClaudeCodeMaxInflight({})).toBe(24)
  expect(getClaudeCodeMaxInflight({FORSKA_CLAUDE_CODE_MAX_INFLIGHT: '2'})).toBe(2)
  expect(getClaudeCodeMaxInflight({FORSKA_CLAUDE_CODE_MAX_INFLIGHT: '0'})).toBe(24)
  expect(getClaudeCodeMaxInflight({FORSKA_CLAUDE_CODE_MAX_INFLIGHT: 'many'})).toBe(24)
})

test('Claude Code connections without a saved limit use the Claude Code family default', () => {
  const previousMaxInflight = process.env.FORSKA_CLAUDE_CODE_MAX_INFLIGHT

  process.env.FORSKA_CLAUDE_CODE_MAX_INFLIGHT = '3'

  try {
    const snapshot = getProviderBucketSnapshot({
      getNonCodexCapacity: () => {
        return {maxBurst: 12, maxInflight: 12, workerCount: 1}
      },
      maxInflightRequests: null,
      modelId: 'model-claude-code',
      modelProvider: 'claude-code',
      providerConnectionId: 'connection-claude-code',
      providerName: 'Claude Code',
    })

    expect(snapshot).toMatchObject({
      providerFamily: 'claude-code',
      providerKey: 'connection-claude-code',
      providerLimit: 3,
      providerUsesFamilyDefault: true,
      resolvedDefaultCapacity: 3,
    })
  } finally {
    if (previousMaxInflight === undefined) {
      delete process.env.FORSKA_CLAUDE_CODE_MAX_INFLIGHT
    } else {
      process.env.FORSKA_CLAUDE_CODE_MAX_INFLIGHT = previousMaxInflight
    }
  }
})
