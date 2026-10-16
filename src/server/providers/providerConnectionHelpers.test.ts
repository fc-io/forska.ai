import {expect, test} from 'bun:test'

import {getProviderConnectionAuthMode} from './providerConnectionHelpers.ts'

test('getProviderConnectionAuthMode uses CLI auth for local CLI providers', () => {
  expect(getProviderConnectionAuthMode({baseURL: null, providerKind: 'claude-code', secretRef: null})).toBe(
    'claude-cli',
  )
  expect(getProviderConnectionAuthMode({baseURL: null, providerKind: 'codex', secretRef: null})).toBe('codex-cli')
  expect(getProviderConnectionAuthMode({baseURL: null, providerKind: 'anthropic', secretRef: 'keychain:x'})).toBe(
    'api-key',
  )
})
