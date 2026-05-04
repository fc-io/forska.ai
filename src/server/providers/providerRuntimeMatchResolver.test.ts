import {expect, test} from 'bun:test'

import {resolveProviderConnectionRuntimeMatchFromSummaries} from './providerRuntimeMatchResolver.ts'

test('equivalent local and launcher runtime matches do not become ambiguous', () => {
  const runtimeMatch = resolveProviderConnectionRuntimeMatchFromSummaries({
    baseURL: 'http://127.0.0.1:30001/v1',
    config: {manualWorkerUrls: [], workerUrlMode: 'runtime'},
    providerKind: 'sglang',
    runtimeSummaries: [
      {
        activeModelNames: ['Qwen/Qwen3.5-27B'],
        providerKind: 'sglang',
        remoteWorkerUrls: ['http://remote-worker.example:30000'],
        sourceMetadata: {
          cluster: 'remote',
          jobId: '6267253',
          kind: 'launcher',
          label: 'Remote',
          sshJumpHost: 'remote-jump',
        },
        workerUrls: ['http://localhost:30001'],
      },
      {
        activeModelNames: ['Qwen/Qwen3.5-27B'],
        providerKind: 'sglang',
        remoteWorkerUrls: ['http://127.0.0.1:30001'],
        sourceMetadata: {cluster: null, jobId: null, kind: 'local', label: 'local', sshJumpHost: null},
        workerUrls: ['http://127.0.0.1:30001'],
      },
    ],
    savedModelIds: ['Qwen/Qwen3.5-27B'],
  })

  expect(runtimeMatch.status).toBe('matched')
  expect(runtimeMatch.sourceMetadata).toEqual({
    cluster: null,
    jobId: null,
    kind: 'local',
    label: 'local',
    sshJumpHost: null,
  })
  expect(runtimeMatch.effectiveBaseURL).toBe('http://127.0.0.1:30001/v1')
  expect(runtimeMatch.effectiveWorkerUrls).toEqual(['http://127.0.0.1:30001'])
})

test('distinct runtime targets remain ambiguous', () => {
  const runtimeMatch = resolveProviderConnectionRuntimeMatchFromSummaries({
    baseURL: 'http://localhost:30001/v1',
    config: {manualWorkerUrls: ['http://127.0.0.1:30002'], workerUrlMode: 'runtime'},
    providerKind: 'sglang',
    runtimeSummaries: [
      {
        activeModelNames: ['Qwen/Qwen3.5-27B'],
        providerKind: 'sglang',
        remoteWorkerUrls: ['http://remote-worker.example:30000'],
        sourceMetadata: {
          cluster: 'remote',
          jobId: '6267253',
          kind: 'launcher',
          label: 'Remote',
          sshJumpHost: 'remote-jump',
        },
        workerUrls: ['http://localhost:30001'],
      },
      {
        activeModelNames: ['Qwen/Qwen3.5-27B'],
        providerKind: 'sglang',
        remoteWorkerUrls: ['http://127.0.0.1:30002'],
        sourceMetadata: {cluster: null, jobId: null, kind: 'local', label: 'local', sshJumpHost: null},
        workerUrls: ['http://127.0.0.1:30002'],
      },
    ],
    savedModelIds: ['Qwen/Qwen3.5-27B'],
  })

  expect(runtimeMatch.status).toBe('ambiguous')
  expect(runtimeMatch.reason).toBe('runtime-url-conflict')
})
