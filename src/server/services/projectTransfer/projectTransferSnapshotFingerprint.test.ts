import {expect, test} from 'bun:test'

import {getProviderConnectionConfigFromJson} from '../../providers/providerDbUtils.ts'
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
    getProviderInput({configJson: {llamaCppMode: 'server', manualWorkerUrls: [], workerUrlMode: 'manual'}}),
  )
  const withMarker = getProjectTransferProviderSnapshotFingerprint(
    getProviderInput({
      configJson: {
        llamaCppMode: 'server',
        manualWorkerUrls: [],
        projectTransferImportedSnapshot: {snapshotFingerprint, sourceProviderConnectionId: 'source-provider'},
        workerUrlMode: 'manual',
      },
    }),
  )

  expect(projectTransferSnapshotFingerprintsEqual(withoutMarker, withMarker)).toBe(true)
})

test('provider snapshot fingerprints default a missing worker URL mode like normalized connection config', () => {
  const providerKinds = ['openai', 'codex', 'llamacpp', 'sglang', 'vllm']
  const results = providerKinds.map((providerKind) => {
    const normalizedConfig = getProviderConnectionConfigFromJson({providerKind, value: {}})
    const raw = getProjectTransferProviderSnapshotFingerprint(getProviderInput({configJson: {}, providerKind}))
    const rawJsonText = getProjectTransferProviderSnapshotFingerprint(
      getProviderInput({configJson: '{}', providerKind}),
    )
    const missing = getProjectTransferProviderSnapshotFingerprint(getProviderInput({configJson: null, providerKind}))
    const normalized = getProjectTransferProviderSnapshotFingerprint(
      getProviderInput({configJson: normalizedConfig, providerKind}),
    )

    return {
      normalizedWorkerUrlMode: normalizedConfig.workerUrlMode,
      providerKind,
      rawJsonTextMatches: projectTransferSnapshotFingerprintsEqual(rawJsonText, normalized),
      rawMatches: projectTransferSnapshotFingerprintsEqual(raw, normalized),
      rawWorkerUrlMode: raw.runtimeMode.workerUrlMode,
      missingMatches: projectTransferSnapshotFingerprintsEqual(missing, normalized),
    }
  })

  expect(
    results.every((result) => {
      return (
        result.rawMatches
        && result.rawJsonTextMatches
        && result.missingMatches
        && result.rawWorkerUrlMode !== null
        && result.rawWorkerUrlMode === result.normalizedWorkerUrlMode
      )
    }),
  ).toBe(true)
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

test('model snapshot fingerprints match dependency source and commit materialized target shapes', () => {
  const dependencySource = getProjectTransferModelSnapshotFingerprint(getModelInput())
  const commitMaterializedTarget = getProjectTransferModelSnapshotFingerprint(
    getModelInput({
      metadataJson: {
        discovery: {contextWindow: {inputTokens: 12000, totalTokens: 16000}},
        options: {thinking: 'high'},
        projectTransferImportedSnapshot: {
          snapshotFingerprint: dependencySource,
          sourceModelId: 'source-model',
          sourceProviderConnectionId: 'source-provider',
        },
      },
      provider: getProviderInput({
        configJson: {
          llamaCppMode: 'server',
          projectTransferImportedSnapshot: {
            snapshotFingerprint: dependencySource.provider,
            sourceProviderConnectionId: 'source-provider',
          },
          manualWorkerUrls: [],
          workerUrlMode: 'manual',
        },
      }),
    }),
  )

  expect(commitMaterializedTarget.model.version).toBe('2026-06-01')
  expect(projectTransferSnapshotFingerprintsEqual(dependencySource, commitMaterializedTarget)).toBe(true)
})
