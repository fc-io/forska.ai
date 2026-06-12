import {createHash} from 'node:crypto'
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'

import {afterAll, beforeEach, expect, mock, test} from 'bun:test'

import type {ProjectTransferSessionRecord} from '../../../db/schemaTypes.ts'
import {projectTransferExecutionThresholds} from './projectTransferContracts.ts'
import type {
  ProjectTransferExportPayloadAssembly,
  ProjectTransferExportSerializedPayloads,
} from './projectTransferExport.ts'
import type {ProjectTransferPayloadByKey} from './projectTransferPayloadSchemas.ts'
import {
  projectTransferPayloadFormatByKey,
  projectTransferPayloadKeys,
  projectTransferPayloadPathByKey,
} from './projectTransferSchemas.ts'
import {getProjectTransferExportTempLayout} from './projectTransferSession.ts'

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
type PersistProjectTransferSessionExportReadyMockParams = {
  completionPayload: {byteLength: number; checksumSha256: string; status: 'ready'}
}
type ProjectTransferExportPackageTestPayloadFile = {
  byteLength: number
  checksumSha256: string
  filePath: string
  format: (typeof projectTransferPayloadFormatByKey)[(typeof projectTransferPayloadKeys)[number]]
  path: string
  recordCount: number
}
type ProjectTransferExportPackageTestStagedRows = {
  assetEntries: ProjectTransferExportPayloadAssembly['assetEntries']
  assetReferences: []
  payloadFiles: Record<string, ProjectTransferExportPackageTestPayloadFile>
  payloads: ProjectTransferPayloadByKey
  warnings: ProjectTransferExportPayloadAssembly['warnings']
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

const getProjectTransferExportPayloadsMock = mock(async (): Promise<ProjectTransferExportPayloadAssembly> => {
  throw new Error('Payload assembly should run in the export worker only')
})
const getProjectTransferExportPreflightEstimateMock = mock(async () => {
  return {
    assetBytes: projectTransferExecutionThresholds.exportInlineAssetBytes + 1,
    packageBytes: 0,
    stagedPayloadBytes: 0,
  }
})
const serializeProjectTransferExportPayloadsMock = mock(() => {
  return projectTransferPayloadKeys.reduce<ProjectTransferExportSerializedPayloads>((payloads, key) => {
    return {...payloads, [key]: key.endsWith('s') ? '' : '{}'}
  }, {} as ProjectTransferExportSerializedPayloads)
})
const getStagedPayloadString = (
  key: (typeof projectTransferPayloadKeys)[number],
  payloads: ProjectTransferPayloadByKey,
) => {
  const payload = payloads[key]

  return projectTransferPayloadFormatByKey[key] === 'ndjson' && Array.isArray(payload)
    ? payload.length === 0
      ? ''
      : `${payload
          .map((record) => {
            return JSON.stringify(record)
          })
          .join('\n')}\n`
    : JSON.stringify(payload)
}
const writeStagedPayloadFiles = (rootPath: string, payloads: ProjectTransferPayloadByKey) => {
  return projectTransferPayloadKeys.reduce<Record<string, ProjectTransferExportPackageTestPayloadFile>>(
    (files, key) => {
      const payload = payloads[key]
      const path = projectTransferPayloadPathByKey[key]
      const filePath = join(rootPath, path)
      const value = getStagedPayloadString(key, payloads)
      const bytes = textEncoder.encode(value)

      mkdirSync(dirname(filePath), {recursive: true})
      writeFileSync(filePath, bytes)

      return {
        ...files,
        [key]: {
          byteLength: bytes.byteLength,
          checksumSha256: createHash('sha256').update(bytes).digest('hex'),
          filePath,
          format: projectTransferPayloadFormatByKey[key],
          path,
          recordCount:
            key === 'project'
              ? 1
              : key === 'assetManifest'
                ? payloads.assetManifest.entries.length
                : Array.isArray(payload)
                  ? payload.length
                  : 0,
        },
      }
    },
    {},
  )
}
const stageProjectTransferExportPayloadRowsMock = mock(
  async ({rootPath}: {rootPath: string}): Promise<ProjectTransferExportPackageTestStagedRows> => {
    const assembly = await getProjectTransferExportPayloadsMock()

    return {
      assetEntries: assembly.assetEntries,
      assetReferences: [],
      payloadFiles: writeStagedPayloadFiles(rootPath, assembly.payloads),
      payloads: assembly.payloads,
      warnings: assembly.warnings,
    }
  },
)
const completeProjectTransferExportStagedPayloadsMock = mock(
  async ({stagedRows}: {stagedRows: ProjectTransferExportPackageTestStagedRows}) => {
    return {
      assetEntries: stagedRows.assetEntries,
      payloadFiles: stagedRows.payloadFiles,
      payloads: stagedRows.payloads,
      warnings: stagedRows.warnings,
    }
  },
)
const createProjectTransferSessionMock = mock(async (_params: CreateProjectTransferSessionMockParams) => {
  return sessionRecord
})
const claimProjectTransferExportSessionOwnerMock = mock(async () => {
  return null
})
const heartbeatProjectTransferExportSessionOwnerMock = mock(async () => {
  return sessionRecord
})
let persistedReadyPayload: PersistProjectTransferSessionExportReadyMockParams['completionPayload'] | null = null
const persistProjectTransferSessionExportReadyMock = mock(
  async (params: PersistProjectTransferSessionExportReadyMockParams) => {
    persistedReadyPayload = params.completionPayload

    return {...sessionRecord, state: 'ready'} satisfies ProjectTransferSessionRecord
  },
)
const failProjectTransferSessionExportMock = mock(async () => {
  return {...sessionRecord, state: 'failed'} satisfies ProjectTransferSessionRecord
})

void mock.module(exportModulePath, () => {
  return {
    completeProjectTransferExportStagedPayloads: completeProjectTransferExportStagedPayloadsMock,
    getProjectTransferExportPayloads: getProjectTransferExportPayloadsMock,
    getProjectTransferExportPreflightEstimate: getProjectTransferExportPreflightEstimateMock,
    serializeProjectTransferExportPayloads: serializeProjectTransferExportPayloadsMock,
    stageProjectTransferExportPayloadRows: stageProjectTransferExportPayloadRowsMock,
  }
})

void mock.module(sessionRepositoryModulePath, () => {
  return {
    getProjectTransferSessionRepository: () => {
      return {
        claimProjectTransferExportSessionOwner: claimProjectTransferExportSessionOwnerMock,
        createProjectTransferSession: createProjectTransferSessionMock,
        failProjectTransferSessionExport: failProjectTransferSessionExportMock,
        heartbeatProjectTransferExportSessionOwner: heartbeatProjectTransferExportSessionOwnerMock,
        persistProjectTransferSessionExportReady: persistProjectTransferSessionExportReadyMock,
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

const getSha256Digest = (bytes: Uint8Array) => {
  return createHash('sha256').update(bytes).digest('hex')
}

const getPayloadAssembly = (): ProjectTransferExportPayloadAssembly => {
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
      modelSignature: {},
      name: 'Large Export',
      provenance: {sourceProjectId: 'project-large'},
      settings: {
        humanJudgmentMode: 'prompt',
        useAbstract: true,
        useFulltext: false,
        useFulltextNoImages: false,
        useTitle: true,
      },
      signature: {
        modelSignature: {},
        name: 'Large Export',
        settings: {
          humanJudgmentMode: 'prompt',
          useAbstract: true,
          useFulltext: false,
          useFulltextNoImages: false,
          useTitle: true,
        },
      },
      sourceProjectId: 'project-large',
    },
    projectArticles: [],
    projectImportRoutes: [],
    projectPrompts: [],
    prompts: [],
    providerConnections: [],
    reviews: [],
  } as ProjectTransferPayloadByKey

  return {
    assetEntries: [{byteLength: 2, bytes: new Uint8Array([1, 2]), path: 'assets/project-transfer-test/large.bin'}],
    payloads,
    warnings: [],
  }
}

beforeEach(() => {
  getProjectTransferExportPayloadsMock.mockClear()
  getProjectTransferExportPreflightEstimateMock.mockClear()
  serializeProjectTransferExportPayloadsMock.mockClear()
  createProjectTransferSessionMock.mockClear()
  claimProjectTransferExportSessionOwnerMock.mockClear()
  heartbeatProjectTransferExportSessionOwnerMock.mockClear()
  persistProjectTransferSessionExportReadyMock.mockClear()
  failProjectTransferSessionExportMock.mockClear()
  persistedReadyPayload = null
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
  const assembly = getPayloadAssembly()
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

test('project-transfer export worker writes background packages directly to an artifact file', async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), `f2-project-transfer-worker-package-${process.pid}-`))
  const layout = getProjectTransferExportTempLayout('export-worker-ready')
  const database = {
    transaction: <TValue>(operation: (runner: unknown) => Promise<TValue>) => {
      return operation({})
    },
  }
  getProjectTransferExportPayloadsMock.mockResolvedValueOnce(getPayloadAssembly())
  claimProjectTransferExportSessionOwnerMock
    .mockResolvedValueOnce({...sessionRecord, ownerToken: 'owner-token', state: 'assembling'})
    .mockResolvedValueOnce({...sessionRecord, ownerToken: 'owner-token', state: 'packaging'})

  try {
    const {runProjectTransferExportSession} = await loadProjectTransferExportPackage()
    const result = await runProjectTransferExportSession({
      cwd: runtimeRoot,
      database: database as never,
      expiresAt,
      exportedAt: now,
      ownerToken: 'owner-token',
      projectId: 'project-large',
      sessionId: 'export-worker-ready',
      zipModule: getFakeZipModule(),
    })
    const packageBytes = new Uint8Array(readFileSync(join(runtimeRoot, layout.packagePath)))

    expect(result?.state).toBe('ready')
    expect(packageBytes.byteLength).toBeGreaterThan(0)
    expect(persistedReadyPayload).toMatchObject({
      byteLength: packageBytes.byteLength,
      checksumSha256: getSha256Digest(packageBytes),
      status: 'ready',
    })
    expect(failProjectTransferSessionExportMock).not.toHaveBeenCalled()
  } finally {
    rmSync(runtimeRoot, {force: true, recursive: true})
  }
})
