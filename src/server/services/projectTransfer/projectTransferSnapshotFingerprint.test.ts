import {expect, test} from 'bun:test'

import {
  getProjectTransferModelSnapshotFingerprint,
  getProjectTransferProviderSnapshotFingerprint,
  projectTransferSnapshotFingerprintsEqual,
} from './projectTransferSnapshotFingerprint.ts'

const getProviderInput = (
  overrides: Partial<Parameters<typeof getProjectTransferProviderSnapshotFingerprint>[0]> = {},
): Parameters<typeof getProjectTransferProviderSnapshotFingerprint>[0] => {
  return {
    authMode: 'api-key',
    baseURL: 'https://api.example.test/v1/',
    configJson: {llamaCppMode: 'server', workerUrlMode: 'manual'},
    providerKind: 'openai',
    ...overrides,
  }
}

const getModelInput = (overrides: Partial<Parameters<typeof getProjectTransferModelSnapshotFingerprint>[0]> = {}) => {
  return {
    displayName: 'Reasoning Model',
    metadataJson: {discovery: {contextWindow: {inputTokens: 12000, totalTokens: 16000}}, options: {thinking: 'high'}},
    modelName: 'reasoning-model',
    name: 'Reasoning Model',
    provider: getProviderInput(),
    remoteModelId: 'reasoning-model',
    variant: 'reasoning',
    version: '2026-06-01',
    ...overrides,
  }
}

test('provider snapshot fingerprints include runtime config identity', () => {
  const manual = getProjectTransferProviderSnapshotFingerprint(getProviderInput())
  const runtime = getProjectTransferProviderSnapshotFingerprint(
    getProviderInput({configJson: {llamaCppMode: 'server', workerUrlMode: 'runtime'}}),
  )

  expect(manual).toMatchObject({
    authMode: 'apikey',
    endpointIdentity: 'https://api.example.test/v1',
    providerKind: 'openai',
    runtimeMode: {llamaCppMode: 'server', workerUrlMode: 'manual'},
    transportFamily: 'openai-responses',
  })
  expect(projectTransferSnapshotFingerprintsEqual(manual, runtime)).toBe(false)
})

test('provider snapshot fingerprints ignore imported markers in target config', () => {
  const snapshotFingerprint = getProjectTransferProviderSnapshotFingerprint(getProviderInput())
  const withoutMarker = getProjectTransferProviderSnapshotFingerprint(
    getProviderInput({configJson: undefined, targetConfig: {manualWorkerUrls: [], workerUrlMode: 'manual'}}),
  )
  const withMarker = getProjectTransferProviderSnapshotFingerprint(
    getProviderInput({
      configJson: undefined,
      targetConfig: {
        manualWorkerUrls: [],
        projectTransferImportedSnapshot: {snapshotFingerprint, sourceProviderConnectionId: 'source-provider'},
        workerUrlMode: 'manual',
      },
    }),
  )

  expect(projectTransferSnapshotFingerprintsEqual(withoutMarker, withMarker)).toBe(true)
})

test('snapshot fingerprints do not include enabled state', () => {
  const enabled = getProjectTransferModelSnapshotFingerprint({...getModelInput(), enabled: true} as never)
  const disabled = getProjectTransferModelSnapshotFingerprint({...getModelInput(), enabled: false} as never)

  expect(projectTransferSnapshotFingerprintsEqual(enabled, disabled)).toBe(true)
})

test('model snapshot fingerprints preserve variant and version separately', () => {
  const baseline = getProjectTransferModelSnapshotFingerprint(getModelInput())
  const differentVersion = getProjectTransferModelSnapshotFingerprint(getModelInput({version: '2026-06-02'}))
  const missingVersion = getProjectTransferModelSnapshotFingerprint(getModelInput({version: null}))

  expect(baseline.model.variant).toBe('reasoning')
  expect(baseline.model.version).toBe('2026-06-01')
  expect(projectTransferSnapshotFingerprintsEqual(baseline, differentVersion)).toBe(false)
  expect(missingVersion.model.variant).toBe('reasoning')
  expect(missingVersion.model.version).toBe(null)
  expect(projectTransferSnapshotFingerprintsEqual(baseline, missingVersion)).toBe(false)
})
