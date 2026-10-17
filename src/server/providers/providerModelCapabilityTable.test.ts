import {expect, test} from 'bun:test'

import {getProviderModelCapabilityTableRow, providerModelCapabilityTable} from './providerModelCapabilityTable.ts'

const isVendorUrl = (value: string) => {
  return /^https:\/\/(developers\.openai\.com|openai\.com|platform\.claude\.com)\//u.test(value)
}

test('every shipped row has a verified date and a vendor source URL for each recorded value', () => {
  const invalidRows = providerModelCapabilityTable.filter((row) => {
    const sourceUrls = [
      row.contextWindow?.sourceUrl,
      row.supportsImageInput?.sourceUrl,
      row.supportsPdfInput?.sourceUrl,
    ].filter((sourceUrl): sourceUrl is string => {
      return sourceUrl !== undefined
    })

    return !/^\d{4}-\d{2}-\d{2}$/u.test(row.verifiedAt) || sourceUrls.length === 0 || !sourceUrls.every(isVendorUrl)
  })

  expect(invalidRows).toEqual([])
})

test('shipped context windows are positive integers with input tokens not above total tokens', () => {
  const invalidRows = providerModelCapabilityTable.filter((row) => {
    return (
      row.contextWindow !== null
      && !(
        Number.isInteger(row.contextWindow.inputTokens)
        && Number.isInteger(row.contextWindow.totalTokens)
        && row.contextWindow.inputTokens > 0
        && row.contextWindow.inputTokens <= row.contextWindow.totalTokens
      )
    )
  })

  expect(invalidRows).toEqual([])
})

test('shipped rows are unique per provider kind and base remote model id', () => {
  const keys = providerModelCapabilityTable.map((row) => {
    return `${row.providerKind}:${row.remoteModelId}`
  })

  expect(new Set(keys).size).toBe(keys.length)
})

test('the enabled live models resolve a context window from the shipped table', () => {
  const liveModels = [
    {providerKind: 'codex', remoteModelId: 'gpt-5.6-sol'},
    {providerKind: 'codex', remoteModelId: 'gpt-6-astra'},
    {providerKind: 'claude-code', remoteModelId: 'claude-opus-5-5'},
    {providerKind: 'claude-code', remoteModelId: 'claude-sonnet-5-5'},
    {providerKind: 'anthropic', remoteModelId: 'claude-opus-4-7'},
  ]

  expect(
    liveModels.map((model) => {
      return getProviderModelCapabilityTableRow(model)?.contextWindow?.inputTokens ?? null
    }),
  ).toEqual([922_000, 922_000, 1_000_000, 1_000_000, 1_000_000])
})

test('unverified models stay out of the table instead of getting a guessed window', () => {
  expect(getProviderModelCapabilityTableRow({providerKind: 'anthropic', remoteModelId: 'claude-opus-4-20250514'})).toBe(
    null,
  )
  expect(
    getProviderModelCapabilityTableRow({providerKind: 'codex', remoteModelId: 'gpt-5.3-codex-spark'})?.contextWindow,
  ).toBeNull()
})
