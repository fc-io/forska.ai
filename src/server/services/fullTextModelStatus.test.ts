import {expect, test} from 'bun:test'

import {type FullTextModelStatusRow, getFullTextModelStatusFromRow} from './fullTextModelStatus.ts'

const getRow = (overrides: Partial<FullTextModelStatusRow> = {}): FullTextModelStatusRow => {
  return {
    connectionEnabled: true,
    lastCheckedAt: '2026-10-17T20:15:30.000Z',
    lastError: null,
    metadataJson: {converter: {kind: 'mineru', serverVersion: '4.0.12'}},
    modelEnabled: true,
    modelId: 'mineru-model',
    modelLabel: 'MinerU standard',
    providerConfigJson: null,
    providerConnectionId: 'mineru-connection',
    providerKind: 'mineru',
    providerLabel: 'MinerU',
    remoteModelId: 'mineru-standard',
    ...overrides,
  }
}

test('a checked connection without an error is healthy with the check time', () => {
  expect(getFullTextModelStatusFromRow(getRow(), 'pdf_conversion').health).toEqual({
    detail: 'The last health check of MinerU passed at 2026-10-17 20:15 UTC.',
    lastCheckedAt: '2026-10-17T20:15:30.000Z',
    lastError: null,
    state: 'healthy',
  })
})

test('a stored error makes the health failed and carries the error text', () => {
  const status = getFullTextModelStatusFromRow(getRow({lastError: ' 503 Service Unavailable '}), 'pdf_conversion')

  expect(status.health.state).toBe('failed')
  expect(status.health.lastError).toBe('503 Service Unavailable')
  expect(status.health.detail).toBe(
    'The last health check of MinerU failed at 2026-10-17 20:15 UTC: 503 Service Unavailable.',
  )
})

test('a connection that was never checked is unverified', () => {
  expect(getFullTextModelStatusFromRow(getRow({lastCheckedAt: null}), 'pdf_conversion').health).toMatchObject({
    detail: 'MinerU has not been health-checked yet. Test the connection on the Models page.',
    state: 'unverified',
  })
})

test('a disabled model, disabled connection or config-disabled model is disabled even with an error', () => {
  const disabledStates = [
    getRow({lastError: 'x', modelEnabled: false}),
    getRow({connectionEnabled: false}),
    getRow({providerConfigJson: {disabledModelIds: ['mineru-model']}}),
  ].map((row) => {
    return getFullTextModelStatusFromRow(row, 'pdf_conversion').health.state
  })

  expect(disabledStates).toEqual(['disabled', 'disabled', 'disabled'])
})

test('the PDF-to-text capability is the reported converter server version', () => {
  expect(getFullTextModelStatusFromRow(getRow(), 'pdf_conversion').capability).toEqual({
    detail: 'Reports mineru 4.0.12.',
    label: 'Converter server version',
    state: 'verified',
  })
  expect(getFullTextModelStatusFromRow(getRow({metadataJson: null}), 'pdf_conversion').capability).toEqual({
    detail: "MinerU standard has not reported a server version. Refresh its provider's models on the Models page.",
    label: 'Converter server version',
    state: 'unverified',
  })
})
