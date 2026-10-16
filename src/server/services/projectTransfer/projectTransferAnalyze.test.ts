import {Buffer} from 'node:buffer'
import {existsSync, mkdtempSync, rmSync} from 'node:fs'
import {mkdir, readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'

import {expect, test} from 'bun:test'

import {analyzeProjectTransferImportPackage} from './projectTransferAnalyze.ts'
import type {ProjectTransferAnalyzeTargetRunner} from './projectTransferAnalyzeTarget.ts'
import {writeProjectTransferCanonicalJsonArtifact} from './projectTransferCanonicalJsonArtifact.ts'
import {type ProjectTransferProgressPayload, validateProjectTransferProgressUpdate} from './projectTransferContracts.ts'
import {
  getProjectTransferCanonicalJson,
  getProjectTransferPackageFingerprint,
  getProjectTransferSha256Checksum,
} from './projectTransferFingerprint.ts'
import {buildProjectTransferManifest, getProjectTransferManifestPayloadEntry} from './projectTransferManifest.ts'
import {
  getProjectTransferPayloadFixtureMap,
  getProjectTransferSchemaVNextFingerprintSortKey,
  type ProjectTransferPayload,
  type ProjectTransferPayloadByKey,
  serializeProjectTransferPayload,
  serializeProjectTransferPayloadForSchemaVersion,
} from './projectTransferPayloadSchemas.ts'
import {
  getProjectTransferPayloadFormatForSchemaVersion,
  getProjectTransferPayloadPathForSchemaVersion,
  projectTransferCurrentManifestSchemaVersion,
  type ProjectTransferManifest,
  projectTransferManifestSchemaVersion,
  type ProjectTransferPackagePayloadKey,
  projectTransferPayloadFormatByKey,
  type ProjectTransferPayloadKey,
  projectTransferPayloadKeys,
  projectTransferPayloadPathByKey,
  projectTransferSchemaVNextPayloadKeys,
} from './projectTransferSchemas.ts'
import {getProjectTransferImportTempLayout} from './projectTransferSession.ts'
import {
  isProjectTransferTargetStateCoverageComplete,
  projectTransferDependencyFingerprintAlgorithm,
  projectTransferDependencyFingerprintCodeVersion,
  projectTransferTargetStateCoverageCodeVersion,
  projectTransferTargetStateSafetySurfaces,
} from './projectTransferTargetStateDirtyTokenService.ts'
import {
  type ProjectTransferZipJsModule,
  type ProjectTransferZipJsUint8ArrayWriter,
  writeProjectTransferZipPackage,
} from './projectTransferZip.ts'

type PackageOverride = {
  manifest?: (manifest: ProjectTransferManifest) => ProjectTransferManifest
  payloads?: (payloads: ProjectTransferPayloadByKey) => ProjectTransferPayloadByKey
  serializedPayloads?: (
    serializedPayloads: Record<ProjectTransferPackagePayloadKey, string>,
    payloads: ProjectTransferPayloadByKey,
  ) => Record<ProjectTransferPackagePayloadKey, string>
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()
const sessionId = 'analyze-session-1'
const assetBytes = textEncoder.encode('fixture-pdf')

type FakeZipEncodedEntry = {bytes: string; path: string}
type FakeZipReadWriter = ProjectTransferZipJsUint8ArrayWriter & {appendChunks: (chunks: readonly Uint8Array[]) => void}

const getRuntimeRoot = () => {
  return mkdtempSync(join(tmpdir(), `f2-project-transfer-analyze-${process.pid}-`))
}

const getFakeZipModule = (): ProjectTransferZipJsModule => {
  class FakeUint8ArrayReader {
    bytes: Uint8Array

    constructor(bytes: Uint8Array) {
      this.bytes = bytes
    }
  }

  class FakeUint8ArrayWriter {
    chunks: Uint8Array[] = []

    appendChunks = (chunks: readonly Uint8Array[]) => {
      this.chunks = [...this.chunks, ...chunks]
    }

    getData = () => {
      const size = this.chunks.reduce((total, chunk) => {
        return total + chunk.byteLength
      }, 0)

      return Buffer.concat(
        this.chunks.map((chunk) => {
          return Buffer.from(chunk)
        }),
        size,
      )
    }
  }

  class FakeZipReader {
    entries: FakeZipEncodedEntry[]

    constructor(reader: unknown) {
      this.entries = JSON.parse(textDecoder.decode((reader as FakeUint8ArrayReader).bytes)) as FakeZipEncodedEntry[]
    }

    close = async () => {}

    getEntries = async () => {
      return this.entries.map((entry) => {
        const bytes = new Uint8Array(Buffer.from(entry.bytes, 'base64'))

        return {
          compressedSize: bytes.byteLength,
          directory: false,
          filename: entry.path,
          getData: async (writer: ProjectTransferZipJsUint8ArrayWriter) => {
            const fakeWriter = writer as FakeZipReadWriter
            fakeWriter.appendChunks([bytes])

            return fakeWriter.getData()
          },
          signature: 1,
          uncompressedSize: bytes.byteLength,
          zip64: false,
        }
      })
    }
  }

  class FakeZipWriter {
    entries: FakeZipEncodedEntry[] = []

    add = async (path: string, reader: unknown) => {
      this.entries = [
        ...this.entries,
        {bytes: Buffer.from((reader as FakeUint8ArrayReader).bytes).toString('base64'), path},
      ]
    }

    close = async () => {
      return textEncoder.encode(JSON.stringify(this.entries))
    }
  }

  return {
    Uint8ArrayReader: FakeUint8ArrayReader,
    Uint8ArrayWriter: FakeUint8ArrayWriter,
    ZipReader: FakeZipReader,
    ZipWriter: FakeZipWriter,
  } satisfies ProjectTransferZipJsModule
}

const getAssetManifestRecordCount = (payload: ProjectTransferPayload) => {
  return (payload as ProjectTransferPayloadByKey['assetManifest']).entries.length
}

const getPayloadRecordCount = (key: ProjectTransferPayloadKey, payload: ProjectTransferPayload) => {
  return key === 'project'
    ? 1
    : key === 'assetManifest'
      ? getAssetManifestRecordCount(payload)
      : Array.isArray(payload)
        ? payload.length
        : 0
}

const getFixturePayloads = (override?: PackageOverride['payloads']) => {
  const payloads = getProjectTransferPayloadFixtureMap()
  const [assetEntry] = payloads.assetManifest.entries

  if (assetEntry === undefined) {
    throw new Error('Expected asset manifest fixture entry')
  }

  const withAssetChecksum = {
    ...payloads,
    assetManifest: {
      ...payloads.assetManifest,
      entries: [
        {
          ...assetEntry,
          byteLength: assetBytes.byteLength,
          checksumSha256: getProjectTransferSha256Checksum(assetBytes),
        },
      ],
    },
  }

  return override ? override(withAssetChecksum) : withAssetChecksum
}

const getSchemaVNextAssetEntryPayload = (entry: ProjectTransferPayloadByKey['assetManifest']['entries'][number]) => {
  const fingerprint = {checksumSha256: entry.checksumSha256, packagePath: entry.packagePath}

  return {
    ...(entry.contentType === undefined ? {} : {contentType: entry.contentType}),
    byteLength: entry.byteLength,
    checksumSha256: entry.checksumSha256,
    fingerprint,
    packagePath: entry.packagePath,
    sortKey: getProjectTransferSchemaVNextFingerprintSortKey(fingerprint),
  }
}

const getSchemaVNextAssetReferencePayload = ({
  assetPackagePath,
  reference,
}: {
  assetPackagePath: string
  reference: ProjectTransferPayloadByKey['assetManifest']['entries'][number]['references'][number]
}) => {
  const payloadKey = 'articles'
  const payloadPath = getProjectTransferPayloadPathForSchemaVersion({
    key: payloadKey,
    schemaVersion: projectTransferManifestSchemaVersion,
  })

  if (payloadPath === undefined) {
    throw new Error('Expected schema-vNext articles payload path')
  }

  const fingerprint = {
    assetPackagePath,
    ...(reference.fieldPath === undefined ? {} : {fieldPath: reference.fieldPath}),
    ...(reference.jsonPointer === undefined ? {} : {jsonPointer: reference.jsonPointer}),
    kind: reference.kind,
    payloadKey,
    payloadPath,
  }

  return {
    assetPackagePath,
    ...(reference.fieldPath === undefined ? {} : {fieldPath: reference.fieldPath}),
    fingerprint,
    ...(reference.jsonPointer === undefined ? {} : {jsonPointer: reference.jsonPointer}),
    kind: reference.kind,
    payloadKey,
    payloadPath,
    sortKey: getProjectTransferSchemaVNextFingerprintSortKey(fingerprint),
    ...(reference.sourceArticleId === undefined ? {} : {sourceArticleId: reference.sourceArticleId}),
    ...(reference.sourceRef === undefined ? {} : {sourceRef: reference.sourceRef}),
  }
}

const getPackagePayloads = (payloads: ProjectTransferPayloadByKey) => {
  return {
    ...payloads,
    assetEntries: payloads.assetManifest.entries.map(getSchemaVNextAssetEntryPayload),
    assetReferences: payloads.assetManifest.entries.flatMap((entry) => {
      return entry.references.map((reference) => {
        return getSchemaVNextAssetReferencePayload({assetPackagePath: entry.packagePath, reference})
      })
    }),
  }
}

const getPackagePayloadRecordCount = (key: ProjectTransferPackagePayloadKey, payload: unknown) => {
  return key === 'project' ? 1 : Array.isArray(payload) ? payload.length : 0
}

const getSerializedPayloads = (payloads: ReturnType<typeof getPackagePayloads>) => {
  return projectTransferSchemaVNextPayloadKeys.reduce<Record<ProjectTransferPackagePayloadKey, string>>(
    (serialized, key) => {
      return {
        ...serialized,
        [key]: serializeProjectTransferPayloadForSchemaVersion(
          projectTransferManifestSchemaVersion,
          key,
          payloads[key],
        ),
      }
    },
    {} as Record<ProjectTransferPackagePayloadKey, string>,
  )
}

const getManifestPayloads = (
  serializedPayloads: Record<ProjectTransferPackagePayloadKey, string>,
  payloads: ReturnType<typeof getPackagePayloads>,
) => {
  return projectTransferSchemaVNextPayloadKeys.reduce<ProjectTransferManifest['payloads']>(
    (manifestPayloads, key) => {
      const format = getProjectTransferPayloadFormatForSchemaVersion({
        key,
        schemaVersion: projectTransferManifestSchemaVersion,
      })
      const path = getProjectTransferPayloadPathForSchemaVersion({
        key,
        schemaVersion: projectTransferManifestSchemaVersion,
      })

      if (format === undefined || path === undefined) {
        throw new Error(`Expected schema-vNext payload contract for ${key}`)
      }

      return {
        ...manifestPayloads,
        [key]: getProjectTransferManifestPayloadEntry({
          bytes: serializedPayloads[key],
          format,
          path,
          recordCount: getPackagePayloadRecordCount(key, payloads[key]),
        }),
      }
    },
    {} as ProjectTransferManifest['payloads'],
  )
}

const getManifest = ({
  manifestOverride,
  payloads,
  serializedPayloads,
}: {
  manifestOverride?: PackageOverride['manifest']
  payloads: ProjectTransferPayloadByKey
  serializedPayloads: Record<ProjectTransferPackagePayloadKey, string>
}) => {
  const packagePayloads = getPackagePayloads(payloads)
  const manifestInput = {
    assetSummary: {byteLength: assetBytes.byteLength, entryCount: payloads.assetManifest.entries.length},
    exportedAt: '2026-05-26T09:00:00.000Z',
    payloads: getManifestPayloads(serializedPayloads, packagePayloads),
    project: {
      counts: projectTransferSchemaVNextPayloadKeys.reduce<Record<ProjectTransferPackagePayloadKey, number>>(
        (counts, key) => {
          return {...counts, [key]: getPackagePayloadRecordCount(key, packagePayloads[key])}
        },
        {} as Record<ProjectTransferPackagePayloadKey, number>,
      ),
      currentModel: {modelName: 'gpt-5.4', remoteModelId: 'gpt-5.4', sourceModelId: 'model-1'},
      humanJudgmentMode: payloads.project.settings.humanJudgmentMode,
      name: payloads.project.name,
      sourceProjectId: payloads.project.sourceProjectId,
    },
    sourceAppVersion: '0.2.1',
    warnings: [],
  }
  const unsignedManifest = buildProjectTransferManifest(manifestInput)
  const packageFingerprint = getProjectTransferPackageFingerprint({
    manifest: unsignedManifest,
    payloads: packagePayloads,
  })
  const manifest = buildProjectTransferManifest({...manifestInput, packageFingerprint})

  return manifestOverride ? manifestOverride(manifest) : manifest
}

const writeAnalyzeUpload = async ({
  cwd,
  manifestOverride,
  payloadOverride,
  serializedPayloadOverride,
  useZipModule = true,
}: {
  cwd: string
  manifestOverride?: PackageOverride['manifest']
  payloadOverride?: PackageOverride['payloads']
  serializedPayloadOverride?: PackageOverride['serializedPayloads']
  useZipModule?: boolean
}) => {
  const layout = getProjectTransferImportTempLayout(sessionId)
  const payloads = getFixturePayloads(payloadOverride)
  const packagePayloads = getPackagePayloads(payloads)
  const defaultSerializedPayloads = getSerializedPayloads(packagePayloads)
  const serializedPayloads = serializedPayloadOverride
    ? serializedPayloadOverride(defaultSerializedPayloads, payloads)
    : defaultSerializedPayloads
  const manifest = getManifest({manifestOverride, payloads, serializedPayloads})
  const zipModule = useZipModule ? getFakeZipModule() : undefined
  const entries = [
    {bytes: getProjectTransferCanonicalJson(manifest), path: 'manifest.json'},
    ...projectTransferSchemaVNextPayloadKeys.map((key) => {
      const path = getProjectTransferPayloadPathForSchemaVersion({
        key,
        schemaVersion: projectTransferManifestSchemaVersion,
      })

      if (path === undefined) {
        throw new Error(`Expected schema-vNext payload path for ${key}`)
      }

      return {bytes: serializedPayloads[key], path}
    }),
    {
      bytes: assetBytes,
      path: payloads.assetManifest.entries[0]?.packagePath ?? 'assets/project-transfer/session-1/article-1.pdf',
    },
  ]
  const zipPackage = await writeProjectTransferZipPackage({entries, zipModule})
  const uploadPath = join(cwd, layout.uploadPath)

  await mkdir(dirname(uploadPath), {recursive: true})
  await globalThis.Bun.write(uploadPath, zipPackage.bytes)

  return {
    layout,
    manifest,
    serializedPayloads,
    uploadMetadata: {
      byteLength: zipPackage.bytes.byteLength,
      checksumSha256: zipPackage.checksumSha256,
      fileName: 'upload.zip',
    },
    zipModule,
  }
}

const getRejectedMessage = async (promise: Promise<unknown>) => {
  return promise.then(
    () => {
      return null
    },
    (error: unknown) => {
      return error instanceof Error ? error.message : String(error)
    },
  )
}

const getEmptyAnalyzeTargetRunner = (): ProjectTransferAnalyzeTargetRunner => {
  return {
    queryJson: async <T>(_statement: string): Promise<T[]> => {
      return []
    },
  }
}

const getTargetStateInitializingAnalyzeRunner = (): ProjectTransferAnalyzeTargetRunner => {
  let initialized = false
  const now = '2026-06-13T12:00:00.000Z'
  const tokenRows = projectTransferTargetStateSafetySurfaces.map((surface) => {
    return {dirtyToken: 0, surface}
  })
  const coverageRow = {
    coverageCodeVersion: projectTransferTargetStateCoverageCodeVersion,
    coveredSurfacesJson: [...projectTransferTargetStateSafetySurfaces],
    dependencyFingerprintAlgorithm: projectTransferDependencyFingerprintAlgorithm,
    dependencyFingerprintCodeVersion: projectTransferDependencyFingerprintCodeVersion,
    initializedAt: now,
    updatedAt: now,
  }
  const getRows = (statement: string): unknown[] => {
    if (!initialized) {
      return []
    }

    if (statement.includes('project_transfer_target_state_coverage')) {
      return [coverageRow]
    }

    if (statement.includes('project_transfer_target_state_unknown_token')) {
      return [{dirtyToken: 0}]
    }

    if (statement.includes('project_transfer_target_state_dirty_token')) {
      return tokenRows
    }

    return []
  }

  return {
    queryJson: async <T>(statement: string): Promise<T[]> => {
      return getRows(statement) as T[]
    },
    run: async (statement: string) => {
      if (statement.includes('project_transfer_target_state_coverage')) {
        initialized = true
      }
    },
  }
}

const getHistoryRow = (packageFingerprint: string) => {
  return {
    commitId: 'commit-duplicate',
    completionPayloadJson: {
      projectId: 'target-project-duplicate',
      projectName: 'Target Duplicate',
      status: 'completed',
    },
    createdAt: new Date('2026-05-20T10:00:00.000Z'),
    direction: 'import',
    id: 'history-duplicate',
    packageFingerprint,
    payloadCountsJson: {articles: 1},
    schemaVersion: 1,
    sessionId: 'session-duplicate',
    sourceProjectId: 'source-project-duplicate',
    sourceProjectName: 'Source Duplicate',
    targetProjectId: 'target-project-duplicate',
    targetProjectName: 'Target Duplicate',
  }
}

const getTargetArticleRow = (overrides: Record<string, unknown> = {}) => {
  return {
    articleAuthors: ['Ada Lovelace', 'Grace Hopper'],
    articleCreatedAt: '2026-01-01T00:00:00.000Z',
    articleId: 'source-app-article-1',
    articleSummary: 'Existing summary',
    articleTitle: 'Fixture Article',
    articleUpdatedAt: null,
    articleVersion: 1,
    arxivId: '2401.12345',
    biorxivId: '10.1101/2024.01.01.123456',
    contentHash: 'target-content-hash',
    doi: '10.1101/2024.01.01.123456',
    fullText: null,
    fullTextAssets: null,
    fullTextCharCount: null,
    fullTextFetchedAt: null,
    fullTextHtml: null,
    fullTextOriginalFormat: null,
    fullTextPdf: null,
    fullTextSource: null,
    importRoute: 'covidence',
    medrxivId: '10.1101/2024.01.01.123456',
    originalData: {source: 'target'},
    publicationStatus: null,
    pubmedId: '12345',
    sourceMetadata: {target: true},
    targetArticleId: 'target-article-1',
    url: 'https://doi.org/10.1101/2024.01.01.123456',
    ...overrides,
  }
}

const getOverlapAnalyzeTargetRunner = (packageFingerprint: string): ProjectTransferAnalyzeTargetRunner => {
  return {
    queryJson: async <T>(statement: string): Promise<T[]> => {
      const rows = statement.includes('FROM app.project_transfer_history')
        ? [getHistoryRow(packageFingerprint)]
        : statement.includes('FROM app.article_identifier')
          ? [{...getTargetArticleRow(), matchedKey: 'doi:10.1101/2024.01.01.123456'}]
          : statement.includes('FROM app.article a') && statement.includes('WHERE a.article_id IN')
            ? []
            : statement.includes('WITH referenced_article')
              ? [
                  {
                    archived: false,
                    dateFrom: null,
                    dateTo: null,
                    projectId: 'active-project-1',
                    targetArticleId: 'target-article-1',
                  },
                ]
              : statement.includes('FROM app.import_route')
                ? [{active: true, route: 'covidence', targetImportRouteId: 'target-route-1'}]
                : statement.includes('FROM app.article_import_route air')
                  ? [
                      {
                        articleCreatedAt: '2026-01-01T00:00:00.000Z',
                        targetArticleId: 'other-route-article',
                        targetImportRouteId: 'target-route-1',
                      },
                    ]
                  : statement.includes('FROM app.project_import_route pir')
                    ? [
                        {
                          archived: true,
                          dateFrom: null,
                          dateTo: null,
                          projectId: 'archived-route-project',
                          targetImportRouteId: 'target-route-1',
                        },
                      ]
                    : []

      return rows as T[]
    },
  }
}

const getDateBoundedRouteAnalyzeTargetRunner = (): ProjectTransferAnalyzeTargetRunner => {
  return {
    queryJson: async <T>(statement: string): Promise<T[]> => {
      const rows = statement.includes('FROM app.article_identifier')
        ? [{...getTargetArticleRow(), matchedKey: 'doi:10.1101/2024.01.01.123456'}]
        : statement.includes('FROM app.import_route')
          ? [{active: true, route: 'covidence', targetImportRouteId: 'target-route-1'}]
          : statement.includes('FROM app.article_import_route air')
            ? [
                {
                  articleCreatedAt: '2025-01-01T00:00:00.000Z',
                  targetArticleId: 'legacy-out-of-window-article',
                  targetImportRouteId: 'target-route-1',
                },
              ]
            : statement.includes('FROM app.project_import_route pir')
              ? [
                  {
                    archived: false,
                    dateFrom: '2027-01-01T00:00:00.000Z',
                    dateTo: null,
                    projectId: 'future-route-project',
                    targetImportRouteId: 'target-route-1',
                  },
                  {
                    archived: true,
                    dateFrom: null,
                    dateTo: null,
                    projectId: 'archived-route-project',
                    targetImportRouteId: 'target-route-1',
                  },
                ]
              : []

      return rows as T[]
    },
  }
}

const getNewArticleRouteAnalyzeTargetRunner = (): ProjectTransferAnalyzeTargetRunner => {
  return {
    queryJson: async <T>(statement: string): Promise<T[]> => {
      const rows = statement.includes('FROM app.import_route')
        ? [{active: true, route: 'covidence', targetImportRouteId: 'target-route-1'}]
        : []

      return rows as T[]
    },
  }
}

const getConflictAnalyzeTargetRunner = (): ProjectTransferAnalyzeTargetRunner => {
  return {
    queryJson: async <T>(statement: string): Promise<T[]> => {
      const rows = statement.includes('FROM app.article_identifier')
        ? [
            {
              ...getTargetArticleRow({targetArticleId: 'target-article-doi'}),
              matchedKey: 'doi:10.1101/2024.01.01.123456',
            },
            {...getTargetArticleRow({targetArticleId: 'target-article-pmid'}), matchedKey: 'pmid:12345'},
          ]
        : []

      return rows as T[]
    },
  }
}

test('analyzes a valid Phase 2 project-transfer package and freezes artifacts', async () => {
  const cwd = getRuntimeRoot()

  try {
    const {layout, manifest, uploadMetadata, zipModule} = await writeAnalyzeUpload({cwd, useZipModule: false})
    const result = await analyzeProjectTransferImportPackage({
      availableDiskBytes: 10_000_000_000,
      cwd,
      layout,
      planRevision: 1,
      runner: getTargetStateInitializingAnalyzeRunner(),
      uploadMetadata,
      zipModule,
    })
    const analysisPath = join(cwd, layout.analysisPath)
    const planPath = join(cwd, layout.planPath)
    const extractedArticlesPath = join(cwd, layout.extractedPath, projectTransferPayloadPathByKey.articles)
    const extractedAssetPath = join(cwd, layout.extractedPath, 'assets/project-transfer/session-1/article-1.pdf')
    const planArtifact = JSON.parse(await readFile(planPath, 'utf8')) as {canCommit: boolean; planRevision: number}
    const extractedArticlesBytes = new Uint8Array(await readFile(extractedArticlesPath))

    expect(result.planSummary.blockerCount).toBe(0)
    expect(result.planSummary.conflictCounts.packageContractConflictCount).toBe(0)
    expect(result.planSummary.overlapCounts.newArticleCount).toBe(1)
    expect(result.planSummary.packageCounts?.articles).toBe(1)
    expect(result.packageFingerprint).toBe(manifest.packageFingerprint)
    expect(result.plan.canCommit).toBe(false)
    expect(result.planSummary.dependencyStatuses).toEqual({
      'model:model-1': 'missing',
      'provider:provider-connection-1': 'missing',
    })
    expect(result.planSummary.judgmentConflictStatus).toBe('unknown')
    expect(result.analysis.payloads.articles.actualRecordCount).toBe(1)
    expect(result.analysis.archive.packageSizeBytes).toBe(uploadMetadata.byteLength)
    expect(result.analysis.stagedPackage?.rowCounts.articles).toBe(1)
    expect(result.analysis.stagedPackage?.canonicalPayloadChecksums.articles).toBe(
      getProjectTransferSha256Checksum(extractedArticlesBytes),
    )
    const targetState = result.plan.targetState
    expect(targetState).not.toBeNull()
    expect(targetState).not.toBeUndefined()

    if (targetState === null || targetState === undefined) {
      throw new Error('Expected analyzed plan target-state snapshot')
    }

    expect(targetState.tableWrites).toBeNull()
    expect(isProjectTransferTargetStateCoverageComplete(targetState)).toBe(false)
    expect(Object.keys(targetState.tokens).sort()).toEqual([...projectTransferTargetStateSafetySurfaces].sort())
    expect(result.staging.stagedPackage?.sourceProject).toMatchObject({
      name: 'Fixture Project',
      schemaVersion: 2,
      sourceProjectId: 'source-project-1',
    })
    expect(planArtifact).toMatchObject({canCommit: false, planRevision: 1})
    expect(existsSync(analysisPath)).toBe(true)
    expect(existsSync(extractedAssetPath)).toBe(true)
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

const trackedAnalyzeScript = `
  const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}, {analyzeProjectTransferImportPackage}, {getProjectTransferImportTempLayout}, {getProjectTransferTargetStateDirtyTokenService}, {getProjectTransferDirtyTokenRevalidationDecision}] = await Promise.all([
    import('./src/db/migrateDuckdb.ts'),
    import('./src/server/services/appDatabaseService.ts'),
    import('./src/server/utils/duckdbService.ts'),
    import('./src/server/utils/serverRuntimeRole.ts'),
    import('./src/server/services/projectTransfer/projectTransferAnalyze.ts'),
    import('./src/server/services/projectTransfer/projectTransferSession.ts'),
    import('./src/server/services/projectTransfer/projectTransferTargetStateDirtyTokenService.ts'),
    import('./src/server/services/projectTransfer/projectTransferDirtyTokenRevalidation.ts'),
  ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()
  await migrateDuckdb()

  const runs = JSON.parse(process.env.PROJECT_TRANSFER_TRACKED_ANALYZE_RUNS ?? '[]')
  const decisions = []

  for (const run of runs) {
    const result = await analyzeProjectTransferImportPackage({
      autoResolveDependencies: true,
      availableDiskBytes: 10_000_000_000,
      cwd: run.cwd,
      layout: getProjectTransferImportTempLayout(run.sessionId),
      onProgress: async (progress) => {
        if (run.writeAfterTargetAnalysis && progress.message === 'Target project analysis completed') {
          await getAppDatabaseService().run("UPDATE app.article SET article_title = 'Edited during analysis', updated_at = now() WHERE id = 'missing-article'")
        }
      },
      planRevision: 1,
      uploadMetadata: run.uploadMetadata,
    })
    const currentTargetState = await getProjectTransferTargetStateDirtyTokenService().getTargetStateDirtyTokenSnapshot()

    decisions.push(getProjectTransferDirtyTokenRevalidationDecision({analyzedTargetState: result.plan.targetState, currentTargetState}))
  }

  console.log(JSON.stringify(decisions))
  await getAppDatabaseService().close()
`

const getTrackedAnalyzeRun = async (writeAfterTargetAnalysis: boolean) => {
  const cwd = getRuntimeRoot()
  const {uploadMetadata} = await writeAnalyzeUpload({cwd, useZipModule: false})

  return {cwd, sessionId, uploadMetadata, writeAfterTargetAnalysis}
}

const runTrackedAnalyzeScript = (runs: Awaited<ReturnType<typeof getTrackedAnalyzeRun>>[]) => {
  const databaseRoot = getRuntimeRoot()
  const result = globalThis.Bun.spawnSync(['bun', '-e', trackedAnalyzeScript], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      API_SERVER_PORT: '39991',
      DUCKDB_PATH: join(databaseRoot, 'tracked-analyze.duckdb'),
      PROJECT_TRANSFER_TRACKED_ANALYZE_RUNS: JSON.stringify(runs),
      SERVER_ROLE: 'dev-single',
      VITE_PORT: '39992',
    },
  })

  try {
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString() || result.stdout.toString() || 'Tracked analyze script failed')
    }

    const lastJsonLine =
      result.stdout
        .toString()
        .split('\n')
        .filter((line) => {
          return line.startsWith('[')
        })
        .at(-1) ?? '[]'

    return JSON.parse(lastJsonLine) as unknown[]
  } finally {
    rmSync(databaseRoot, {force: true, recursive: true})
  }
}

test('analyze captures the target-state snapshot before target analysis reads the target tables', async () => {
  const runs = [await getTrackedAnalyzeRun(false), await getTrackedAnalyzeRun(true)]

  try {
    const [unchanged, writtenAfterTargetAnalysis] = runTrackedAnalyzeScript(runs)

    expect(unchanged).toMatchObject({eligible: true, status: 'incremental_revalidation_allowed'})
    expect(writtenAfterTargetAnalysis).toMatchObject({
      changedSurfaces: ['article'],
      reason: 'target_state_table_write_changed',
      status: 'full_revalidation_required',
    })
  } finally {
    runs.map((run) => {
      return rmSync(run.cwd, {force: true, recursive: true})
    })
  }
}, 120_000)

test('releases raw archive buffers before target analysis', async () => {
  const source = await readFile(new URL('./projectTransferAnalyze.ts', import.meta.url), 'utf8')
  const releaseStart = source.indexOf(
    'const archiveEntries = releaseProjectTransferAnalyzeArchiveBuffers(zipPackage.entries)',
  )
  const releaseEnd = source.indexOf('globalThis.Bun.gc(true)', releaseStart) + 'globalThis.Bun.gc(true)'.length
  const targetAnalysisStart = source.indexOf('const targetAnalysisMeasurement =', releaseEnd)
  const afterRelease = source.slice(releaseEnd)
  const afterReleaseWithoutMetricKeys = afterRelease.replaceAll(/packageBytes\s*:/g, '')

  expect(releaseStart).toBeGreaterThan(-1)
  expect(releaseEnd).toBeGreaterThan(releaseStart)
  expect(targetAnalysisStart).toBeGreaterThan(releaseEnd)
  expect(afterReleaseWithoutMetricKeys).not.toContain('packageBytes')
  expect(afterRelease).not.toContain('zipPackage')
})

test('auto-resolves provider and model dependencies during analyze when enabled', async () => {
  const cwd = getRuntimeRoot()

  try {
    const progressEvents: {phase: string; status: string}[] = []
    const progressMessages: (string | null | undefined)[] = []
    const {layout, uploadMetadata, zipModule} = await writeAnalyzeUpload({cwd, useZipModule: false})
    const result = await analyzeProjectTransferImportPackage({
      autoResolveDependencies: true,
      availableDiskBytes: 10_000_000_000,
      cwd,
      dependencyResolutionRepositories: {
        listProviderConnections: async () => {
          return []
        },
      },
      layout,
      onProgress: (progress) => {
        progressEvents.push({phase: progress.phase, status: progress.status})
        progressMessages.push(progress.message)
      },
      planRevision: 1,
      runner: getEmptyAnalyzeTargetRunner(),
      uploadMetadata,
      zipModule,
    })
    const planPath = join(cwd, layout.planPath)
    const planArtifact = JSON.parse(await readFile(planPath, 'utf8')) as {
      canCommit: boolean
      dependencyResolution: {
        modelTargetBySourceId: Record<string, string>
        providerTargetBySourceId: Record<string, string>
      }
      planRevision: number
      summary: {dependencyStatuses: Record<string, string>; judgmentConflictStatus: string}
    }

    expect(result.planSummary.dependencyStatuses).toEqual({
      'model:model-1': 'resolved',
      'provider:provider-connection-1': 'resolved',
    })
    expect(result.planSummary.judgmentConflictStatus).toBe('clear')
    expect(result.plan.planRevision).toBe(1)
    expect(result.plan.dependencyResolution?.providerTargetBySourceId).toEqual({
      'provider-connection-1': 'new:provider:provider-connection-1',
    })
    expect(result.plan.dependencyResolution?.modelTargetBySourceId).toEqual({'model-1': 'new:model:model-1'})
    expect(planArtifact.planRevision).toBe(1)
    expect(planArtifact.canCommit).toBe(true)
    expect(planArtifact.dependencyResolution.providerTargetBySourceId).toEqual({
      'provider-connection-1': 'new:provider:provider-connection-1',
    })
    expect(planArtifact.dependencyResolution.modelTargetBySourceId).toEqual({'model-1': 'new:model:model-1'})
    expect(progressEvents).toContainEqual({phase: 'dependency_resolution', status: 'running'})
    expect(progressEvents).toContainEqual({phase: 'dependency_resolution', status: 'completed'})
    expect(progressMessages.indexOf('Planning import changes')).toBe(
      progressMessages.indexOf('Target project analysis completed') + 1,
    )
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('publishes one monotonic overall analyze percent across every phase', async () => {
  const cwd = getRuntimeRoot()

  try {
    const progressEvents: ProjectTransferProgressPayload[] = []
    const queryState = {delayed: false}
    const {layout, uploadMetadata, zipModule} = await writeAnalyzeUpload({cwd, useZipModule: false})
    const runner: ProjectTransferAnalyzeTargetRunner = {
      queryJson: async <T>(_statement: string): Promise<T[]> => {
        if (!queryState.delayed) {
          queryState.delayed = true
          await new Promise((resolve) => {
            setTimeout(resolve, 1_100)
          })
        }

        return []
      },
    }

    await analyzeProjectTransferImportPackage({
      autoResolveDependencies: true,
      availableDiskBytes: 10_000_000_000,
      cwd,
      dependencyResolutionRepositories: {
        listProviderConnections: async () => {
          return []
        },
      },
      layout,
      onProgress: (progress) => {
        progressEvents.push(progress)
      },
      planRevision: 1,
      runner,
      uploadMetadata,
      zipModule,
    })

    const percents = progressEvents.map((progress) => {
      return progress.overall?.percent ?? -1
    })
    const stepKeys = progressEvents.reduce<string[]>((keys, progress) => {
      const key = progress.overall?.step.key ?? 'missing'

      return keys.at(-1) === key ? keys : [...keys, key]
    }, [])

    expect(
      progressEvents.every((progress) => {
        return progress.overall?.operation === 'analyze'
      }),
    ).toBe(true)
    expect(percents[0]).toBe(3)
    expect(percents.at(-1)).toBe(95)
    expect(
      percents.every((percent, index) => {
        return index === 0 || percent >= (percents[index - 1] ?? 0)
      }),
    ).toBe(true)
    expect(stepKeys).toEqual(['zipScan', 'payloadParse', 'targetAnalysis', 'dependencies', 'finalize'])
    expect(
      progressEvents.find((progress) => {
        return progress.message === 'Loading target analysis tables'
      })?.overall,
    ).toMatchObject({percent: 56, step: {key: 'targetAnalysis'}})
    expect(
      progressEvents.every((progress, index) => {
        return validateProjectTransferProgressUpdate({next: progress, previous: progressEvents[index - 1] ?? null}).ok
      }),
    ).toBe(true)
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('refreshes the atomic progress artifact while target analysis remains pending', async () => {
  const cwd = getRuntimeRoot()
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  const intervalCallbacks: (() => void)[] = []
  const intervalDurations: number[] = []
  let clearedIntervalCount = 0
  let heartbeatPublishedCount = 0
  let releaseHeartbeatUpdates = () => {}
  let releaseTargetQuery = () => {}
  let resolveFirstHeartbeat = () => {}
  let resolveSecondHeartbeat = () => {}
  let resolveTargetQueryStarted = () => {}
  const heartbeatUpdatesReleased = new Promise<void>((resolve) => {
    releaseHeartbeatUpdates = resolve
  })
  const firstHeartbeatPublished = new Promise<void>((resolve) => {
    resolveFirstHeartbeat = resolve
  })
  const secondHeartbeatPublished = new Promise<void>((resolve) => {
    resolveSecondHeartbeat = resolve
  })
  const targetQueryReleased = new Promise<void>((resolve) => {
    releaseTargetQuery = resolve
  })
  const targetQueryStarted = new Promise<void>((resolve) => {
    resolveTargetQueryStarted = resolve
  })
  let targetQueryPaused = false
  let analyzeAttempt: ReturnType<typeof analyzeProjectTransferImportPackage> | null = null

  globalThis.setInterval = ((callback: () => void, intervalMs?: number) => {
    intervalCallbacks.push(callback)
    intervalDurations.push(intervalMs ?? 0)
    return {unref: () => {}}
  }) as typeof setInterval
  globalThis.clearInterval = (() => {
    clearedIntervalCount += 1
  }) as typeof clearInterval

  try {
    const {layout, uploadMetadata, zipModule} = await writeAnalyzeUpload({cwd, useZipModule: false})
    const progressPath = join(cwd, layout.progressPath)
    const runner: ProjectTransferAnalyzeTargetRunner = {
      queryJson: async <T>(_statement: string): Promise<T[]> => {
        if (!targetQueryPaused) {
          targetQueryPaused = true
          resolveTargetQueryStarted()
          await targetQueryReleased
        }

        return []
      },
    }
    analyzeAttempt = analyzeProjectTransferImportPackage({
      availableDiskBytes: 10_000_000_000,
      cwd,
      layout,
      onProgress: async (progress) => {
        await writeProjectTransferCanonicalJsonArtifact({filePath: progressPath, value: progress})

        if (targetQueryPaused) {
          heartbeatPublishedCount += 1
          const resolvePublished = heartbeatPublishedCount === 1 ? resolveFirstHeartbeat : resolveSecondHeartbeat
          resolvePublished()
          await heartbeatUpdatesReleased
        }
      },
      planRevision: 1,
      runner,
      uploadMetadata,
      zipModule,
    })

    await targetQueryStarted
    expect(intervalCallbacks).toHaveLength(1)
    expect(intervalDurations).toEqual([15_000])

    intervalCallbacks[0]?.()
    await firstHeartbeatPublished
    const firstHeartbeat = JSON.parse(await readFile(progressPath, 'utf8')) as {
      message: string
      status: string
      updatedAt: string
    }

    releaseHeartbeatUpdates()
    await new Promise((resolve) => {
      setTimeout(resolve, 5)
    })
    intervalCallbacks[0]?.()
    await secondHeartbeatPublished
    const secondHeartbeat = JSON.parse(await readFile(progressPath, 'utf8')) as {
      message: string
      status: string
      updatedAt: string
    }

    expect(heartbeatPublishedCount).toBe(2)
    expect(firstHeartbeat).toMatchObject({message: 'Waiting for DuckDB maintenance work to pause', status: 'running'})
    expect(secondHeartbeat).toMatchObject({message: firstHeartbeat.message, status: 'running'})
    expect(new Date(secondHeartbeat.updatedAt).getTime()).toBeGreaterThan(new Date(firstHeartbeat.updatedAt).getTime())
    expect(clearedIntervalCount).toBe(0)

    releaseHeartbeatUpdates()
    releaseTargetQuery()
    await analyzeAttempt
    expect(clearedIntervalCount).toBe(1)
  } finally {
    releaseHeartbeatUpdates()
    releaseTargetQuery()
    await analyzeAttempt?.catch(() => {
      return undefined
    })
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('rejects schema-1 project-transfer packages after schema-vNext cutover', async () => {
  const cwd = getRuntimeRoot()

  try {
    const layout = getProjectTransferImportTempLayout(sessionId)
    const payloads = getFixturePayloads()
    const serializedPayloads = projectTransferPayloadKeys.reduce<Record<ProjectTransferPayloadKey, string>>(
      (serialized, key) => {
        return {...serialized, [key]: serializeProjectTransferPayload(key, payloads[key])}
      },
      {} as Record<ProjectTransferPayloadKey, string>,
    )
    const manifestInput = {
      assetSummary: {byteLength: assetBytes.byteLength, entryCount: payloads.assetManifest.entries.length},
      exportedAt: '2026-05-26T09:00:00.000Z',
      payloads: projectTransferPayloadKeys.reduce<ProjectTransferManifest['payloads']>(
        (manifestPayloads, key) => {
          return {
            ...manifestPayloads,
            [key]: getProjectTransferManifestPayloadEntry({
              bytes: serializedPayloads[key],
              format: projectTransferPayloadFormatByKey[key],
              path: projectTransferPayloadPathByKey[key],
              recordCount: getPayloadRecordCount(key, payloads[key]),
            }),
          }
        },
        {} as ProjectTransferManifest['payloads'],
      ),
      project: {
        counts: projectTransferPayloadKeys.reduce<Record<ProjectTransferPayloadKey, number>>(
          (counts, key) => {
            return {...counts, [key]: getPayloadRecordCount(key, payloads[key])}
          },
          {} as Record<ProjectTransferPayloadKey, number>,
        ),
        currentModel: {modelName: 'gpt-5.4', remoteModelId: 'gpt-5.4', sourceModelId: 'model-1'},
        humanJudgmentMode: payloads.project.settings.humanJudgmentMode,
        name: payloads.project.name,
        sourceProjectId: payloads.project.sourceProjectId,
      },
      schemaVersion: projectTransferCurrentManifestSchemaVersion,
      sourceAppVersion: '0.2.1',
      warnings: [],
    }
    const unsignedManifest = buildProjectTransferManifest(manifestInput)
    const manifest = buildProjectTransferManifest({
      ...manifestInput,
      packageFingerprint: getProjectTransferPackageFingerprint({manifest: unsignedManifest, payloads}),
    })
    const zipModule = getFakeZipModule()
    const zipEntries = [
      {bytes: getProjectTransferCanonicalJson(manifest), path: 'manifest.json'},
      ...projectTransferPayloadKeys.map((key) => {
        return {bytes: serializedPayloads[key], path: projectTransferPayloadPathByKey[key]}
      }),
    ]
    const zipBytes = textEncoder.encode(
      JSON.stringify(
        zipEntries.map((entry) => {
          return {bytes: Buffer.from(entry.bytes).toString('base64'), path: entry.path}
        }),
      ),
    )
    const uploadPath = join(cwd, layout.uploadPath)

    await mkdir(dirname(uploadPath), {recursive: true})
    await globalThis.Bun.write(uploadPath, zipBytes)

    const message = await getRejectedMessage(
      analyzeProjectTransferImportPackage({
        availableDiskBytes: 10_000_000_000,
        cwd,
        layout,
        planRevision: 1,
        runner: getEmptyAnalyzeTargetRunner(),
        uploadMetadata: {
          byteLength: zipBytes.byteLength,
          checksumSha256: getProjectTransferSha256Checksum(zipBytes),
          fileName: 'legacy-upload.zip',
        },
        zipModule,
      }),
    )

    expect(message).toContain('unsupported_schema_version')
    expect(message).toContain('schema 1 import is unsupported')
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('rejects unsupported package fingerprints while sanitizing article route paths', async () => {
  const cwd = getRuntimeRoot()

  try {
    const {layout, manifest, uploadMetadata, zipModule} = await writeAnalyzeUpload({
      cwd,
      manifestOverride: (currentManifest) => {
        return {...currentManifest, packageFingerprint: getProjectTransferSha256Checksum('legacy-fingerprint')}
      },
      payloadOverride: (payloads) => {
        return {
          ...payloads,
          articles: payloads.articles.map((article) => {
            return {
              ...article,
              importRoute: '/Users/export/legacy-route.csv',
              selectedImportRoute: 'file:///Users/export/selected-route.csv',
            }
          }),
        }
      },
    })
    const result = await analyzeProjectTransferImportPackage({
      availableDiskBytes: 10_000_000_000,
      cwd,
      layout,
      planRevision: 1,
      runner: getEmptyAnalyzeTargetRunner(),
      uploadMetadata,
      zipModule,
    })
    const extractedArticlesText = await readFile(
      join(cwd, layout.extractedPath, projectTransferPayloadPathByKey.articles),
      'utf8',
    )
    const blockerCodes = result.planSummary.blockers.map((blocker) => {
      return blocker.code
    })

    expect(manifest.packageFingerprint).not.toBe(result.packageFingerprint)
    expect(blockerCodes).toContain('unsupported_package_fingerprint')
    expect(blockerCodes).not.toContain('article_absolute_path_reference')
    expect(extractedArticlesText).toContain('"importRoute":null')
    expect(extractedArticlesText).toContain('"selectedImportRoute":null')
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('preserves API article routes during package fingerprint validation', async () => {
  const cwd = getRuntimeRoot()

  try {
    const {layout, manifest, uploadMetadata, zipModule} = await writeAnalyzeUpload({
      cwd,
      payloadOverride: (payloads) => {
        return {
          ...payloads,
          articles: payloads.articles.map((article) => {
            return {
              ...article,
              importRoute: '/api/datasources/import/pubmed',
              selectedImportRoute: '/api/datasources/import/pubmed',
            }
          }),
        }
      },
    })
    const result = await analyzeProjectTransferImportPackage({
      availableDiskBytes: 10_000_000_000,
      cwd,
      layout,
      planRevision: 1,
      runner: getEmptyAnalyzeTargetRunner(),
      uploadMetadata,
      zipModule,
    })
    const extractedArticlesText = await readFile(
      join(cwd, layout.extractedPath, projectTransferPayloadPathByKey.articles),
      'utf8',
    )
    const blockerCodes = result.planSummary.blockers.map((blocker) => {
      return blocker.code
    })

    expect(result.packageFingerprint).toBe(manifest.packageFingerprint)
    expect(blockerCodes).not.toContain('unsupported_package_fingerprint')
    expect(extractedArticlesText).toContain('"/api/datasources/import/pubmed"')
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('plans reused article fills, asset promotion, route omissions, and duplicate warnings', async () => {
  const cwd = getRuntimeRoot()

  try {
    const {layout, manifest, uploadMetadata, zipModule} = await writeAnalyzeUpload({
      cwd,
      payloadOverride: (payloads) => {
        return {
          ...payloads,
          articles: payloads.articles.map((article) => {
            return {
              ...article,
              articleId: 'source-app-article-1',
              fullTextPdf: payloads.assetManifest.entries[0]?.packagePath ?? null,
            }
          }),
        }
      },
    })
    const result = await analyzeProjectTransferImportPackage({
      availableDiskBytes: 10_000_000_000,
      cwd,
      layout,
      planRevision: 4,
      runner: getOverlapAnalyzeTargetRunner(manifest.packageFingerprint ?? ''),
      uploadMetadata,
      zipModule,
    })
    const [articleMatch] = result.plan.targetPlan.articleMatches
    const [articleUpdate] = result.plan.targetPlan.articleUpdatePlan

    expect(result.planSummary.blockerCount).toBe(5)
    expect(result.planSummary.conflictCounts.judgmentConflictCount).toBe(2)
    expect(result.planSummary.conflictCounts.humanReviewFidelityConflictCount).toBe(3)
    expect(result.planSummary.warningCount).toBeGreaterThanOrEqual(1)
    expect(result.planSummary.overlapCounts.reusedArticleCount).toBe(1)
    expect(result.planSummary.overlapCounts.newArticleCount).toBe(0)
    expect(result.planSummary.overlapCounts.reusedArticleUpdateCount).toBe(1)
    expect(result.planSummary.overlapCounts.reusedArticleFieldFillCount).toBe(1)
    expect(result.planSummary.overlapCounts.reusedArticleAssetPromotionCount).toBe(1)
    expect(result.planSummary.overlapCounts.dirtiedExistingProjectCount).toBe(1)
    expect(result.planSummary.overlapCounts.omittedRouteLinkCount).toBe(1)
    expect(result.planSummary.overlapCounts.omittedArticleRouteLinkCount).toBe(0)
    expect(result.planSummary.overlapCounts.routeArticleSnapshotLinkCount).toBe(0)
    expect(result.planSummary.overlapCounts.duplicateImportMatchCount).toBe(1)
    expect(articleMatch?.candidates[0]?.matchedIdentifiers).toEqual([
      {identifierType: 'doi', key: 'doi:10.1101/2024.01.01.123456', value: '10.1101/2024.01.01.123456'},
    ])
    expect(
      articleUpdate?.fieldFills.map((fill) => {
        return fill.field
      }),
    ).toEqual(['fullTextPdf'])
    expect(result.plan.targetPlan.assetPromotionPlan[0]?.packagePath).toBe(
      'assets/project-transfer/session-1/article-1.pdf',
    )
    expect(result.plan.targetPlan.duplicateImportMatches).toHaveLength(1)
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('links date-bounded routes when only extra target-route articles are outside scope', async () => {
  const cwd = getRuntimeRoot()

  try {
    const {layout, uploadMetadata, zipModule} = await writeAnalyzeUpload({
      cwd,
      payloadOverride: (payloads) => {
        return {
          ...payloads,
          project: {...payloads.project, dateFrom: '2026-01-01T00:00:00.000Z', dateTo: '2026-01-31T23:59:59.999Z'},
        }
      },
    })
    const result = await analyzeProjectTransferImportPackage({
      availableDiskBytes: 10_000_000_000,
      cwd,
      layout,
      planRevision: 6,
      runner: getDateBoundedRouteAnalyzeTargetRunner(),
      uploadMetadata,
      zipModule,
    })
    const [projectRoute] = result.plan.targetPlan.projectRoutePlan
    const [articleRoute] = result.plan.targetPlan.articleRoutePlan

    expect(projectRoute).toMatchObject({
      action: 'link',
      dateBoundedOutsideExportedArticleCount: 0,
      outsideExportedArticleCount: 1,
      targetImportRouteId: 'target-route-1',
    })
    expect(articleRoute).toMatchObject({
      action: 'write',
      targetArticleId: 'target-article-1',
      targetImportRouteId: 'target-route-1',
      unsafeProjectIds: [],
    })
    expect(result.planSummary.overlapCounts.omittedRouteLinkCount).toBe(0)
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('writes route memberships for newly created articles when the target route is safe', async () => {
  const cwd = getRuntimeRoot()

  try {
    const {layout, uploadMetadata, zipModule} = await writeAnalyzeUpload({cwd})
    const result = await analyzeProjectTransferImportPackage({
      availableDiskBytes: 10_000_000_000,
      cwd,
      layout,
      planRevision: 7,
      runner: getNewArticleRouteAnalyzeTargetRunner(),
      uploadMetadata,
      zipModule,
    })
    const [articleMatch] = result.plan.targetPlan.articleMatches
    const [articleRoute] = result.plan.targetPlan.articleRoutePlan

    expect(articleMatch).toMatchObject({action: 'create', selectedTargetArticleId: null})
    expect(articleRoute).toMatchObject({
      action: 'write',
      targetArticleId: null,
      targetImportRouteId: 'target-route-1',
      unsafeProjectIds: [],
    })
    expect(result.planSummary.overlapCounts.omittedArticleRouteLinkCount).toBe(0)
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('blocks article identifier conflicts and project-prompt canonical remap collisions', async () => {
  const cwd = getRuntimeRoot()

  try {
    const {layout, uploadMetadata, zipModule} = await writeAnalyzeUpload({
      cwd,
      payloadOverride: (payloads) => {
        const prompt = payloads.prompts[0]
        const projectPrompt = payloads.projectPrompts[0]

        if (prompt === undefined || projectPrompt === undefined) {
          throw new Error('Expected prompt fixtures')
        }

        return {
          ...payloads,
          projectPrompts: [
            projectPrompt,
            {
              ...projectPrompt,
              order: 2,
              sourceProjectPromptId: 'project-prompt-collision',
              sourcePromptId: 'prompt-collision',
            },
          ],
          prompts: [prompt, {...prompt, sourcePromptId: 'prompt-collision'}],
        }
      },
    })
    const result = await analyzeProjectTransferImportPackage({
      availableDiskBytes: 10_000_000_000,
      cwd,
      layout,
      planRevision: 5,
      runner: getConflictAnalyzeTargetRunner(),
      uploadMetadata,
      zipModule,
    })

    expect(result.plan.canCommit).toBe(false)
    expect(result.planSummary.conflictCounts.articleConflictCount).toBeGreaterThan(0)
    expect(result.planSummary.conflictCounts.projectPromptConflictCount).toBeGreaterThan(0)
    expect(
      result.plan.blockers.map((blocker) => {
        return blocker.code
      }),
    ).toContain('article_identifier_conflict')
    expect(
      result.plan.blockers.map((blocker) => {
        return blocker.code
      }),
    ).toContain('project_prompt_canonical_remap_collision')
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('blocks duplicate package article identifiers before commit', async () => {
  const cwd = getRuntimeRoot()

  try {
    const {layout, uploadMetadata, zipModule} = await writeAnalyzeUpload({
      cwd,
      payloadOverride: (payloads) => {
        const article = payloads.articles[0]

        if (article === undefined) {
          throw new Error('Expected article fixture')
        }

        return {
          ...payloads,
          articles: [
            article,
            {
              ...article,
              articleId: 'source-app-article-duplicate',
              articleTitle: 'Fixture Article Duplicate',
              provenance: {sourceArticleId: 'article-duplicate'},
              signature: {...article.signature, title: 'Fixture Article Duplicate'},
              sourceArticleId: 'article-duplicate',
            },
          ],
        }
      },
    })
    const result = await analyzeProjectTransferImportPackage({
      availableDiskBytes: 10_000_000_000,
      cwd,
      layout,
      planRevision: 5,
      runner: getNewArticleRouteAnalyzeTargetRunner(),
      uploadMetadata,
      zipModule,
    })

    expect(result.plan.canCommit).toBe(false)
    expect(result.planSummary.conflictCounts.articleConflictCount).toBeGreaterThanOrEqual(2)
    const blockerCodes = result.plan.blockers.map((blocker) => {
      return blocker.code
    })
    expect(blockerCodes).toContain('article_identifier_package_duplicate')
    expect(
      result.plan.targetPlan.articleMatches.map((match) => {
        return {action: match.action, sourceArticleId: match.sourceArticleId}
      }),
    ).toEqual([
      {action: 'blocked', sourceArticleId: 'article-1'},
      {action: 'blocked', sourceArticleId: 'article-duplicate'},
    ])
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('exposes package-contract blockers with non-wizard resolution kinds', async () => {
  const cwd = getRuntimeRoot()

  try {
    const {layout, uploadMetadata, zipModule} = await writeAnalyzeUpload({
      cwd,
      manifestOverride: (manifest) => {
        return {
          ...manifest,
          project: {
            ...manifest.project,
            counts: {...manifest.project.counts, articles: manifest.project.counts.articles + 1},
          },
        }
      },
    })
    const result = await analyzeProjectTransferImportPackage({
      availableDiskBytes: 10_000_000_000,
      cwd,
      layout,
      planRevision: 2,
      runner: getEmptyAnalyzeTargetRunner(),
      uploadMetadata,
      zipModule,
    })

    expect(result.planSummary.blockerCount).toBe(1)
    expect(result.planSummary.conflictCounts.packageContractConflictCount).toBe(1)
    expect(result.plan.canCommit).toBe(false)
    expect(result.plan.blockers[0]).toMatchObject({
      code: 'project_summary_count_mismatch',
      resolutionKind: 'requires_new_package_or_target_changes',
    })
    expect(result.plan.resolutionKinds.project_summary_count_mismatch).toBe('requires_new_package_or_target_changes')
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('records streamed NDJSON row validation failures as package-contract blockers', async () => {
  const cwd = getRuntimeRoot()

  try {
    const {layout, uploadMetadata, zipModule} = await writeAnalyzeUpload({
      cwd,
      serializedPayloadOverride: (serializedPayloads) => {
        return {...serializedPayloads, articles: '{"sourceArticleId":"","articleTitle":""}\n'}
      },
    })
    const result = await analyzeProjectTransferImportPackage({
      availableDiskBytes: 10_000_000_000,
      cwd,
      layout,
      planRevision: 8,
      runner: getEmptyAnalyzeTargetRunner(),
      uploadMetadata,
      zipModule,
    })
    const blockerCodes = result.planSummary.blockers.map((blocker) => {
      return blocker.code
    })
    const extractedArticlesText = await readFile(
      join(cwd, layout.extractedPath, projectTransferPayloadPathByKey.articles),
      'utf8',
    )

    expect(blockerCodes).toContain('payload_row_contract_invalid')
    expect(result.planSummary.conflictCounts.packageContractConflictCount).toBeGreaterThan(0)
    expect(result.planSummary.blockerCount).toBeGreaterThan(0)
    expect(result.plan.canCommit).toBe(false)
    expect(result.analysis.payloads.articles.actualRecordCount).toBe(0)
    expect(result.analysis.stagedPackage?.payloads.articles?.invalidRecordCount).toBe(1)
    expect(result.analysis.stagedPackage?.rowCounts.articles).toBe(0)
    expect(extractedArticlesText).toBe('')
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('stages large NDJSON payloads without accumulating per-line write stream error listeners', async () => {
  const cwd = getRuntimeRoot()
  const maxListenerWarnings: string[] = []
  const onWarning = (warning: Error) => {
    if (warning.name === 'MaxListenersExceededWarning' && warning.message.includes('WriteStream')) {
      maxListenerWarnings.push(warning.message)
    }
  }

  process.on('warning', onWarning)

  try {
    const largeText = 'x'.repeat(64 * 1024)
    const {layout, uploadMetadata, zipModule} = await writeAnalyzeUpload({
      cwd,
      payloadOverride: (payloads) => {
        const [article] = payloads.articles

        if (article === undefined) {
          throw new Error('Expected article fixture')
        }

        return {
          ...payloads,
          articles: Array.from({length: 24}, (_value, index) => {
            return {
              ...article,
              fullText: largeText,
              provenance: {...article.provenance, sourceArticleId: `article-${index + 1}`},
              sourceArticleId: `article-${index + 1}`,
            }
          }),
        }
      },
    })

    await analyzeProjectTransferImportPackage({
      availableDiskBytes: 10_000_000_000,
      cwd,
      layout,
      planRevision: 9,
      runner: getEmptyAnalyzeTargetRunner(),
      uploadMetadata,
      zipModule,
    })
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })

    expect(maxListenerWarnings).toEqual([])
  } finally {
    process.off('warning', onWarning)
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('normalizes schema-vNext NDJSON payloads to legacy JSON artifacts for downstream consumers', async () => {
  const cwd = getRuntimeRoot()

  try {
    const {layout, uploadMetadata, zipModule} = await writeAnalyzeUpload({cwd})

    await analyzeProjectTransferImportPackage({
      availableDiskBytes: 10_000_000_000,
      cwd,
      layout,
      planRevision: 9,
      runner: getEmptyAnalyzeTargetRunner(),
      uploadMetadata,
      zipModule,
    })

    const legacyProjectPromptsText = await readFile(
      join(cwd, layout.extractedPath, projectTransferPayloadPathByKey.projectPrompts),
      'utf8',
    )
    const parsedLegacyProjectPrompts = JSON.parse(legacyProjectPromptsText) as unknown

    expect(Array.isArray(parsedLegacyProjectPrompts)).toBe(true)
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test.each(['legacy', 'screening_v1'] as const)(
  'keeps %s staged judgments and compact plan identities consistent',
  async (systemPromptVariant) => {
    const cwd = getRuntimeRoot()

    try {
      const {layout, manifest, serializedPayloads, uploadMetadata, zipModule} = await writeAnalyzeUpload({
        cwd,
        payloadOverride: (payloads) => {
          return {
            ...payloads,
            judgments: payloads.judgments.map((judgment) => {
              return {...judgment, systemPromptVariant}
            }),
          }
        },
      })
      const result = await analyzeProjectTransferImportPackage({
        availableDiskBytes: 10_000_000_000,
        cwd,
        layout,
        planRevision: 10,
        runner: getEmptyAnalyzeTargetRunner(),
        uploadMetadata,
        zipModule,
      })
      const stagedJudgments = await readFile(
        join(cwd, layout.extractedPath, projectTransferPayloadPathByKey.judgments),
        'utf8',
      )
      const [judgmentPlan] = result.plan.targetPlan.judgmentPlan ?? []

      expect(stagedJudgments).toBe(serializedPayloads.judgments)
      expect(result.analysis.computedPackageFingerprint).toBe(manifest.packageFingerprint)
      expect(result.analysis.stagedPackage?.packageFingerprintInputs.checksumSha256).toBe(manifest.packageFingerprint)
      expect(judgmentPlan?.inputSignatureMatches).toBe(true)
      expect(judgmentPlan?.physicalKey).toContain(`|${systemPromptVariant}`)
      expect(judgmentPlan?.reviewVisibleKey).toContain(`|${systemPromptVariant}`)
    } finally {
      rmSync(cwd, {force: true, recursive: true})
    }
  },
)

test('aborts checksum failures before plan artifact creation', async () => {
  const cwd = getRuntimeRoot()

  try {
    const {layout, uploadMetadata, zipModule} = await writeAnalyzeUpload({
      cwd,
      manifestOverride: (manifest) => {
        return {
          ...manifest,
          payloads: {...manifest.payloads, project: {...manifest.payloads.project, checksumSha256: 'b'.repeat(64)}},
        }
      },
    })

    const message = await getRejectedMessage(
      analyzeProjectTransferImportPackage({
        availableDiskBytes: 10_000_000_000,
        cwd,
        layout,
        planRevision: 3,
        runner: getEmptyAnalyzeTargetRunner(),
        uploadMetadata,
        zipModule,
      }),
    )

    expect(message).toContain('payload checksum')
    expect(existsSync(join(cwd, layout.planPath))).toBe(false)
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

const stagedParityJudgment = {
  ...getProjectTransferPayloadFixtureMap().judgments[0],
  quotes: ['Å🙂\u2028', '\ud800', 'quote"\n\\'],
  confidenceOriginal: 1,
}
const stagedParityRows = [
  stagedParityJudgment,
  {
    ...stagedParityJudgment,
    sourceJudgmentId: 'j-second',
    quotes: [],
    nested: {warnings: ['existing'], omissions: ['omitted'], redactions: ['redacted'], keep: true},
  },
]
const stagedParityBytes =
  '{"answeredOriginal":"include","answeredOriginalAsArray":["include"],"confidenceOriginal":1,"contentSettings":{"humanJudgmentMode":"prompt","useAbstract":true,"useFulltext":false,"useFulltextNoImages":false,"useTitle":true},"explanation":"Fixture explanation","isAnswered":true,"judgmentInputSignature":{"article":{"articleSummaryDigest":null,"articleTitleDigest":"36d65cf053f87083c5e58147b84331742d20bec64e37e3e77831482122c57fa6","contentHash":null,"fullTextAssetsDigest":null,"fullTextDigest":null,"fullTextHtmlDigest":null,"fullTextPdfReferenceDigest":null,"identifierKeys":["arxiv:2401.12345","doi:10.1101/2024.01.01.123456","pmid:12345"],"promptInput":{"articleSummaryDigest":null,"articleTitleDigest":"36d65cf053f87083c5e58147b84331742d20bec64e37e3e77831482122c57fa6","promptOriginalTextDigest":"57fff23fa1930f01b7c37bb4f83ac0adbf1620b1d5d08852ac677780ffa2e338","promptTemplateFamily":"judgeGetSinglePrompt:v1","promptType":"system","sourceTextWrapper":"sourceTextBoundaryWrapper:v1"}},"chunking":{"chunkEvidenceDigests":null,"finalPromptDigest":null,"strategy":null},"contentSettings":{"humanJudgmentMode":"prompt","useAbstract":true,"useFulltext":false,"useFulltextNoImages":false,"useTitle":true},"fullTextProcessing":{"maxTokens":null,"processedTextDigest":null,"stripImages":false,"tokenCount":null,"withinBudget":null},"kind":"judgmentInputSignature","model":{"contextLimit":32768,"modelOptions":{"thinking":"medium"},"modelSignature":{"displayName":"GPT 5.4","modelName":"gpt-5.4","name":"GPT 5.4","providerConnectionSignature":{"authMode":"apiKey","baseURL":null,"configSignature":{"apiVersion":"2026-05-21"},"providerKind":"openai"},"remoteModelId":"gpt-5.4","variant":null,"version":null},"promptTokenLimit":28768},"prompt":{"contentHash":"c4f659c8baf0066f65ecb7006731b24d","originalTextDigest":"57fff23fa1930f01b7c37bb4f83ac0adbf1620b1d5d08852ac677780ffa2e338","promptHeading":"Eligibility","serializedPromptIdentifier":null,"transformedTextDigest":null,"type":"system"},"provider":{"providerConnectionSignature":{"authMode":"apiKey","baseURL":null,"configSignature":{"apiVersion":"2026-05-21"},"providerKind":"openai"},"providerKind":"openai","transportFamily":"openai-responses"},"request":{"evidenceOutputSchemaDigest":"fixture-evidence-schema-digest","evidenceSystemPromptDigest":null,"invocationTemperature":0.2,"maxRetries":2,"outputSchemaDigest":"fixture-output-schema-digest","providerInvocationAdapter":"invokeStoredProviderModel:v1","quoteValidationContract":"exact-source-substring:v1","reservedCompletionTokens":4000,"retryContract":"json-schema-and-quote-validation:v1","systemPromptDigest":"fixture-system-prompt-digest","systemPromptFamily":"getSinglePromptSystemPromptForArticle:v2","systemPromptVariant":"legacy"},"version":1},"judgmentInputSignatureProvenance":{"kind":"currentReviewRows","version":1},"provenance":{"sourceArticleId":"article-1","sourceModelId":"model-1","sourcePromptId":"prompt-1"},"quotes":["\u00c5\ud83d\ude42\u2028","\\ud800","quote\\"\\n\\\\"],"signature":{"articleSignature":{"identifierKeys":["arxiv:2401.12345","doi:10.1101/2024.01.01.123456","pmid:12345"],"title":"Fixture Article"},"contentSettings":{"humanJudgmentMode":"prompt","useAbstract":true,"useFulltext":false,"useFulltextNoImages":false,"useTitle":true},"modelSignature":{"displayName":"GPT 5.4","modelName":"gpt-5.4","name":"GPT 5.4","providerConnectionSignature":{"authMode":"apiKey","baseURL":null,"configSignature":{"apiVersion":"2026-05-21"},"providerKind":"openai"},"remoteModelId":"gpt-5.4","variant":null,"version":null},"promptSignature":{"contentHash":"c4f659c8baf0066f65ecb7006731b24d","originalText":"Include the study?"}},"sourceArticleId":"article-1","sourceJudgmentId":"judgment-1","sourceModelId":"model-1","sourcePromptId":"prompt-1"}\n{"answeredOriginal":"include","answeredOriginalAsArray":["include"],"confidenceOriginal":1,"contentSettings":{"humanJudgmentMode":"prompt","useAbstract":true,"useFulltext":false,"useFulltextNoImages":false,"useTitle":true},"explanation":"Fixture explanation","isAnswered":true,"judgmentInputSignature":{"article":{"articleSummaryDigest":null,"articleTitleDigest":"36d65cf053f87083c5e58147b84331742d20bec64e37e3e77831482122c57fa6","contentHash":null,"fullTextAssetsDigest":null,"fullTextDigest":null,"fullTextHtmlDigest":null,"fullTextPdfReferenceDigest":null,"identifierKeys":["arxiv:2401.12345","doi:10.1101/2024.01.01.123456","pmid:12345"],"promptInput":{"articleSummaryDigest":null,"articleTitleDigest":"36d65cf053f87083c5e58147b84331742d20bec64e37e3e77831482122c57fa6","promptOriginalTextDigest":"57fff23fa1930f01b7c37bb4f83ac0adbf1620b1d5d08852ac677780ffa2e338","promptTemplateFamily":"judgeGetSinglePrompt:v1","promptType":"system","sourceTextWrapper":"sourceTextBoundaryWrapper:v1"}},"chunking":{"chunkEvidenceDigests":null,"finalPromptDigest":null,"strategy":null},"contentSettings":{"humanJudgmentMode":"prompt","useAbstract":true,"useFulltext":false,"useFulltextNoImages":false,"useTitle":true},"fullTextProcessing":{"maxTokens":null,"processedTextDigest":null,"stripImages":false,"tokenCount":null,"withinBudget":null},"kind":"judgmentInputSignature","model":{"contextLimit":32768,"modelOptions":{"thinking":"medium"},"modelSignature":{"displayName":"GPT 5.4","modelName":"gpt-5.4","name":"GPT 5.4","providerConnectionSignature":{"authMode":"apiKey","baseURL":null,"configSignature":{"apiVersion":"2026-05-21"},"providerKind":"openai"},"remoteModelId":"gpt-5.4","variant":null,"version":null},"promptTokenLimit":28768},"prompt":{"contentHash":"c4f659c8baf0066f65ecb7006731b24d","originalTextDigest":"57fff23fa1930f01b7c37bb4f83ac0adbf1620b1d5d08852ac677780ffa2e338","promptHeading":"Eligibility","serializedPromptIdentifier":null,"transformedTextDigest":null,"type":"system"},"provider":{"providerConnectionSignature":{"authMode":"apiKey","baseURL":null,"configSignature":{"apiVersion":"2026-05-21"},"providerKind":"openai"},"providerKind":"openai","transportFamily":"openai-responses"},"request":{"evidenceOutputSchemaDigest":"fixture-evidence-schema-digest","evidenceSystemPromptDigest":null,"invocationTemperature":0.2,"maxRetries":2,"outputSchemaDigest":"fixture-output-schema-digest","providerInvocationAdapter":"invokeStoredProviderModel:v1","quoteValidationContract":"exact-source-substring:v1","reservedCompletionTokens":4000,"retryContract":"json-schema-and-quote-validation:v1","systemPromptDigest":"fixture-system-prompt-digest","systemPromptFamily":"getSinglePromptSystemPromptForArticle:v2","systemPromptVariant":"legacy"},"version":1},"judgmentInputSignatureProvenance":{"kind":"currentReviewRows","version":1},"provenance":{"sourceArticleId":"article-1","sourceModelId":"model-1","sourcePromptId":"prompt-1"},"quotes":[],"signature":{"articleSignature":{"identifierKeys":["arxiv:2401.12345","doi:10.1101/2024.01.01.123456","pmid:12345"],"title":"Fixture Article"},"contentSettings":{"humanJudgmentMode":"prompt","useAbstract":true,"useFulltext":false,"useFulltextNoImages":false,"useTitle":true},"modelSignature":{"displayName":"GPT 5.4","modelName":"gpt-5.4","name":"GPT 5.4","providerConnectionSignature":{"authMode":"apiKey","baseURL":null,"configSignature":{"apiVersion":"2026-05-21"},"providerKind":"openai"},"remoteModelId":"gpt-5.4","variant":null,"version":null},"promptSignature":{"contentHash":"c4f659c8baf0066f65ecb7006731b24d","originalText":"Include the study?"}},"sourceArticleId":"article-1","sourceJudgmentId":"j-second","sourceModelId":"model-1","sourcePromptId":"prompt-1","nested":{"warnings":["existing","omitted","redacted"],"keep":true}}\n'

test.each(['canonical', 'noncanonical'] as const)(
  'preserves characterized staged bytes for %s NDJSON',
  async (inputKind) => {
    const cwd = getRuntimeRoot()
    const rawLines = stagedParityRows.map((row) => {
      return JSON.stringify(row)
    })
    const canonicalInput = `${rawLines.join('\n')}\n`
    const noncanonicalInput = `\n \t${(rawLines[0] ?? '').replace('"confidenceOriginal":1', '"confidenceOriginal":1e0').replace('Å', '\\u00c5')}\r\n\n${rawLines[1]} `
    const input = inputKind === 'canonical' ? canonicalInput : noncanonicalInput

    try {
      const {layout, uploadMetadata, zipModule} = await writeAnalyzeUpload({
        cwd,
        serializedPayloadOverride: (serializedPayloads) => {
          return {...serializedPayloads, judgments: input}
        },
      })
      const result = await analyzeProjectTransferImportPackage({
        availableDiskBytes: 10_000_000_000,
        cwd,
        layout,
        planRevision: 11,
        runner: getEmptyAnalyzeTargetRunner(),
        uploadMetadata,
        zipModule,
      })
      const stagedBytes = await readFile(join(cwd, layout.extractedPath, projectTransferPayloadPathByKey.judgments))

      expect(stagedBytes.equals(Buffer.from(stagedParityBytes))).toBe(true)
      expect(getProjectTransferSha256Checksum(stagedBytes)).toBe(
        '2634c95302c86b8c81f379e6e4c8da9dcdd8c20c08fe7b91f3b30de2cd078c5e',
      )
      expect(result.analysis.stagedPackage?.payloads.judgments).toMatchObject({
        canonicalByteLength: 7540,
        canonicalChecksumSha256: '2634c95302c86b8c81f379e6e4c8da9dcdd8c20c08fe7b91f3b30de2cd078c5e',
        invalidRecordCount: 0,
        logicalDigestSha256: 'fa9bbf246015fb3016db6a6e20c879ea1cfd1c2456d7d106ff27c4dc67a885e5',
        recordCount: 2,
      })
    } finally {
      rmSync(cwd, {force: true, recursive: true})
    }
  },
)

test('real DuckDB analyze progress publishes without waiting on its open transaction', async () => {
  const cwd = getRuntimeRoot()
  const databaseRoot = getRuntimeRoot()
  try {
    const {uploadMetadata} = await writeAnalyzeUpload({cwd, useZipModule: false})
    const script = `
      const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
      const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
      const {getProjectTransferSessionRepository} = await import('./src/server/services/projectTransfer/projectTransferSessionRepository.ts')
      const {analyzeProjectTransferImportPackage} = await import('./src/server/services/projectTransfer/projectTransferAnalyze.ts')
      const {getProjectTransferImportTempLayout} = await import('./src/server/services/projectTransfer/projectTransferSession.ts')
      const {writeFile, readFile} = await import('node:fs/promises')
      const {join} = await import('node:path')
      await migrateDuckdb()
      const repository = getProjectTransferSessionRepository()
      const sessionId = 'analyze-session-1'
      const layout = getProjectTransferImportTempLayout(sessionId)
      await repository.createProjectTransferSession({direction: 'import', expiresAt: new Date(Date.now() + 60000), id: sessionId, state: 'analyzing'})
      const {isDuckdbExclusiveWorkLeaseContext} = await import('./src/server/utils/duckdbExclusiveWork.ts')
      const {getProjectTransferCompletedOverallProgress} = await import('./src/server/services/projectTransfer/projectTransferProgressWeights.ts')
      const sessionContexts = []
      const written = []
      const timeout = setTimeout(() => { console.error('ANALYZE_PROGRESS_TIMEOUT', JSON.stringify(written)); process.exit(124) }, 15000)
      const result = await analyzeProjectTransferImportPackage({
        availableDiskBytes: 10000000000,
        cwd: process.env.PROGRESS_TEST_ROOT,
        layout,
        planRevision: 1,
        progressThrottleMs: 0,
        uploadMetadata: JSON.parse(process.env.PROGRESS_TEST_UPLOAD),
        onProgress: async (progress) => {
          const path = join(process.env.PROGRESS_TEST_ROOT, layout.progressPath)
          await writeFile(path, JSON.stringify(progress))
          written.push(JSON.parse(await readFile(path, 'utf8')).overall.percent)
          if (progress.message === 'Waiting for DuckDB maintenance work to pause') await new Promise(resolve => setTimeout(resolve, 1100))
        },
        onSessionProgress: (progress) => {
          sessionContexts.push(isDuckdbExclusiveWorkLeaseContext())
          return repository.updateProjectTransferSessionProgress({sessionId, progress})
        },
      })
      const completed = {...(await repository.getProjectTransferSession({sessionId})).progressJson, status: 'completed', overall: getProjectTransferCompletedOverallProgress('analyze')}
      await writeFile(join(process.env.PROGRESS_TEST_ROOT, layout.progressPath), JSON.stringify(completed))
      written.push(JSON.parse(await readFile(join(process.env.PROGRESS_TEST_ROOT, layout.progressPath), 'utf8')).overall.percent)
      await repository.updateProjectTransferSessionProgress({sessionId, progress: completed})
      clearTimeout(timeout)
      console.log(JSON.stringify({written, sessionContexts, final: (await repository.getProjectTransferSession({sessionId})).progressJson.overall.percent, analyzed: !!result.plan}))
      await getAppDatabaseService().close()
    `
    const child = globalThis.Bun.spawn([process.execPath, '-e', script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DUCKDB_PATH: join(databaseRoot, 'progress.duckdb'),
        DUCKDB_MEMORY_LIMIT: '512MB',
        SERVER_ROLE: 'dev-single',
        API_SERVER_PORT: '39991',
        VITE_PORT: '39992',
        PROGRESS_TEST_ROOT: cwd,
        PROGRESS_TEST_UPLOAD: JSON.stringify(uploadMetadata),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const kill = setTimeout(() => {
      child.kill()
    }, 45000)
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    clearTimeout(kill)
    expect({exitCode, error: exitCode === 0 ? '' : stderr.slice(-2000)}).toEqual({exitCode: 0, error: ''})
    const result = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as {
      written: number[]
      sessionContexts: boolean[]
      final: number
      analyzed: boolean
    }
    expect(result.analyzed).toBe(true)
    expect(result.written).toEqual(
      [...result.written].sort((a, b) => {
        return a - b
      }),
    )
    expect(result.written.at(-1)).toBe(100)
    expect(result.final).toBe(100)
    expect(result.sessionContexts.length).toBeGreaterThan(0)
    expect(
      result.sessionContexts.every((insideLease) => {
        return !insideLease
      }),
    ).toBe(true)
  } finally {
    rmSync(cwd, {force: true, recursive: true})
    rmSync(databaseRoot, {force: true, recursive: true})
  }
}, 60000)
