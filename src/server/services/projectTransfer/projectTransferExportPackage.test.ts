import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {afterAll, beforeEach, expect, mock, test} from 'bun:test'

import type {ProjectTransferSessionRecord} from '../../../db/schemaTypes.ts'
import {projectTransferExecutionThresholds} from './projectTransferContracts.ts'
import type {
  ProjectTransferExportPayloadAssembly,
  ProjectTransferExportSerializedPayloads,
} from './projectTransferExport.ts'
import type {ProjectTransferPayloadByKey} from './projectTransferPayloadSchemas.ts'
import {projectTransferPayloadKeys} from './projectTransferSchemas.ts'

const exportModulePath = new URL('./projectTransferExport.ts', import.meta.url).pathname
const sessionRepositoryModulePath = new URL('./projectTransferSessionRepository.ts', import.meta.url).pathname
const textEncoder = new TextEncoder()

type CreateProjectTransferSessionMockParams = {
  completionPayload?: {status?: string}
  direction?: string
  expiresAt?: Date
  id?: string
  state?: string
}

const now = new Date('2026-05-24T08:00:00.000Z')
const expiresAt = new Date('2026-05-25T08:00:00.000Z')
const sessionRecord: ProjectTransferSessionRecord = {
  commitId: null,
  completionPayloadJson: null,
  createdAt: now,
  direction: 'export',
  errorJson: null,
  expiresAt,
  heartbeatAt: null,
  id: 'export-large',
  ownerToken: null,
  packageFingerprint: null,
  planRevision: 0,
  planSummaryJson: null,
  progressJson: null,
  state: 'queued',
  terminalCleanupAt: null,
  updatedAt: now,
}

const getProjectTransferExportPayloadsMock = mock(async () => {
  throw new Error('Payload assembly should run in the export worker only')
})
const getProjectTransferExportPreflightEstimateMock = mock(async () => {
  return {assetBytes: projectTransferExecutionThresholds.exportInlineAssetBytes + 1, packageBytes: 0}
})
const serializeProjectTransferExportPayloadsMock = mock(() => {
  return projectTransferPayloadKeys.reduce<ProjectTransferExportSerializedPayloads>((payloads, key) => {
    return {...payloads, [key]: key.endsWith('s') ? '' : '{}'}
  }, {} as ProjectTransferExportSerializedPayloads)
})
const createProjectTransferSessionMock = mock(async (_params: CreateProjectTransferSessionMockParams) => {
  return sessionRecord
})
const claimProjectTransferExportSessionOwnerMock = mock(async () => {
  return null
})

void mock.module(exportModulePath, () => {
  return {
    getProjectTransferExportPayloads: getProjectTransferExportPayloadsMock,
    getProjectTransferExportPreflightEstimate: getProjectTransferExportPreflightEstimateMock,
    serializeProjectTransferExportPayloads: serializeProjectTransferExportPayloadsMock,
  }
})

void mock.module(sessionRepositoryModulePath, () => {
  return {
    getProjectTransferSessionRepository: () => {
      return {
        claimProjectTransferExportSessionOwner: claimProjectTransferExportSessionOwnerMock,
        createProjectTransferSession: createProjectTransferSessionMock,
      }
    },
  }
})

const loadProjectTransferExportPackage = async (): Promise<typeof import('./projectTransferExportPackage.ts')> => {
  return (await import(
    `./projectTransferExportPackage.ts?test=${Date.now()}-${Math.random()}`
  )) as typeof import('./projectTransferExportPackage.ts')
}

const getFakeZipModule = () => {
  class FakeUint8ArrayReader {
    bytes: Uint8Array

    constructor(bytes: Uint8Array) {
      this.bytes = bytes
    }
  }

  class FakeUint8ArrayWriter {
    getData = () => {
      return new Uint8Array()
    }
  }

  class FakeZipReader {
    close = async () => {}
    getEntries = async () => {
      return []
    }
  }

  class FakeZipWriter {
    paths: string[] = []

    add = async (path: string) => {
      this.paths.push(path)
    }

    close = async () => {
      return textEncoder.encode(JSON.stringify(this.paths))
    }
  }

  return {
    Uint8ArrayReader: FakeUint8ArrayReader,
    Uint8ArrayWriter: FakeUint8ArrayWriter,
    ZipReader: FakeZipReader,
    ZipWriter: FakeZipWriter,
  }
}

beforeEach(() => {
  getProjectTransferExportPayloadsMock.mockClear()
  getProjectTransferExportPreflightEstimateMock.mockClear()
  serializeProjectTransferExportPayloadsMock.mockClear()
  createProjectTransferSessionMock.mockClear()
  claimProjectTransferExportSessionOwnerMock.mockClear()
})

afterAll(() => {
  mock.restore()
})

test('project-transfer export queues background sessions before payload assembly', async () => {
  const {createProjectTransferExport} = await loadProjectTransferExportPackage()

  const result = await createProjectTransferExport({
    expiresAt,
    exportedAt: now,
    projectId: 'project-large',
    sessionId: 'export-large',
  })

  expect(result.executionMode).toBe('background')
  expect(result.sessionId).toBe('export-large')
  expect(result.metadata.downloadUrl).toBe('/api/projects/export/export-large/download')
  expect(createProjectTransferSessionMock).toHaveBeenCalledWith({
    direction: 'export',
    expiresAt,
    id: 'export-large',
    state: 'queued',
  })
  expect(claimProjectTransferExportSessionOwnerMock).toHaveBeenCalled()
  expect(getProjectTransferExportPayloadsMock).not.toHaveBeenCalled()
})

test('project-transfer export reuses completed builds when actual size crosses background threshold', async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), `f2-project-transfer-package-${process.pid}-`))
  const originalInlineAssetBytes = projectTransferExecutionThresholds.exportInlineAssetBytes
  const thresholds = projectTransferExecutionThresholds as unknown as {exportInlineAssetBytes: number}
  const payloads = {
    articleImportRoutes: [],
    articles: [],
    assetManifest: {entries: []},
    humanJudgmentSummaries: [],
    humanJudgments: [],
    importRoutes: [],
    judgmentAssessments: [],
    judgments: [],
    models: [],
    project: {
      humanJudgmentMode: 'prompt',
      modelSignature: null,
      name: 'Large Export',
      settings: {humanJudgmentMode: 'prompt'},
      sourceProjectId: 'project-large',
    },
    projectArticles: [],
    projectImportRoutes: [],
    projectPrompts: [],
    prompts: [],
    providerConnections: [],
    reviews: [],
  } as ProjectTransferPayloadByKey
  const assembly = {
    assetEntries: [{bytes: new Uint8Array([1, 2]), path: 'assets/project-transfer-test/large.bin'}],
    payloads,
    warnings: [],
  } satisfies ProjectTransferExportPayloadAssembly
  const database = {
    transaction: <TValue>(operation: (runner: unknown) => Promise<TValue>) => {
      return operation({})
    },
  }

  thresholds.exportInlineAssetBytes = 1
  getProjectTransferExportPreflightEstimateMock.mockResolvedValueOnce({assetBytes: 0, packageBytes: 0})
  getProjectTransferExportPayloadsMock.mockResolvedValueOnce(assembly)

  try {
    const {createProjectTransferExport} = await loadProjectTransferExportPackage()
    const result = await createProjectTransferExport({
      cwd: runtimeRoot,
      database: database as never,
      expiresAt,
      exportedAt: now,
      projectId: 'project-large',
      sessionId: 'export-large-ready',
      zipModule: getFakeZipModule(),
    })

    expect(result.executionMode).toBe('background')
    expect(result.sessionId).toBe('export-large-ready')
    expect(result.metadata.downloadUrl).toBe('/api/projects/export/export-large-ready/download')
    expect(createProjectTransferSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({direction: 'export', id: 'export-large-ready', state: 'ready'}),
    )
    const readySessionCreateCall = createProjectTransferSessionMock.mock.calls.find(([params]) => {
      return params.id === 'export-large-ready'
    })
    expect(readySessionCreateCall?.[0].completionPayload).toMatchObject({status: 'ready'})
    expect(claimProjectTransferExportSessionOwnerMock).not.toHaveBeenCalled()
    expect(getProjectTransferExportPayloadsMock).toHaveBeenCalledTimes(1)
  } finally {
    thresholds.exportInlineAssetBytes = originalInlineAssetBytes
    rmSync(runtimeRoot, {force: true, recursive: true})
  }
})
