import {afterEach, expect, test} from 'bun:test'

import {getCodexMaxInflight} from './getCodexMaxInflight.ts'
import {getProviderBucketSnapshot} from './providerAdmissionLease.ts'

const previousCodexMaxInflight = process.env.CODEX_MAX_INFLIGHT

afterEach(() => {
  if (previousCodexMaxInflight === undefined) {
    delete process.env.CODEX_MAX_INFLIGHT
  } else {
    process.env.CODEX_MAX_INFLIGHT = previousCodexMaxInflight
  }
})

test('getCodexMaxInflight defaults to 35 and honors CODEX_MAX_INFLIGHT', () => {
  delete process.env.CODEX_MAX_INFLIGHT
  expect(getCodexMaxInflight()).toBe(35)

  process.env.CODEX_MAX_INFLIGHT = '2'
  expect(getCodexMaxInflight()).toBe(2)

  process.env.CODEX_MAX_INFLIGHT = '0'
  expect(getCodexMaxInflight()).toBe(35)

  process.env.CODEX_MAX_INFLIGHT = ''
  expect(getCodexMaxInflight()).toBe(35)
})

test('Codex connections without a saved limit use the Codex family default', () => {
  delete process.env.CODEX_MAX_INFLIGHT

  const snapshot = getProviderBucketSnapshot({
    getNonCodexCapacity: () => {
      return {maxBurst: 12, maxInflight: 12, workerCount: 1}
    },
    maxInflightRequests: null,
    modelId: 'model-codex',
    modelProvider: 'codex',
    providerConnectionId: 'connection-codex',
    providerName: 'Codex',
  })

  expect(snapshot).toMatchObject({
    providerFamily: 'codex',
    providerKey: 'connection-codex',
    providerLimit: 35,
    providerUsesFamilyDefault: true,
    resolvedDefaultCapacity: 35,
  })
})
