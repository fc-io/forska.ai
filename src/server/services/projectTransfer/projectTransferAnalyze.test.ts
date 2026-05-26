import {Buffer} from 'node:buffer'
import {existsSync, mkdtempSync, rmSync} from 'node:fs'
import {mkdir, readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'

import {expect, test} from 'bun:test'

import {analyzeProjectTransferImportPackage} from './projectTransferAnalyze.ts'
import type {ProjectTransferAnalyzeTargetRunner} from './projectTransferAnalyzeTarget.ts'
import {
  getProjectTransferCanonicalJson,
  getProjectTransferPackageFingerprint,
  getProjectTransferSha256Checksum,
} from './projectTransferFingerprint.ts'
import {buildProjectTransferManifest, getProjectTransferManifestPayloadEntry} from './projectTransferManifest.ts'
import {
  getProjectTransferPayloadFixtureMap,
  type ProjectTransferPayload,
  type ProjectTransferPayloadByKey,
  serializeProjectTransferPayload,
} from './projectTransferPayloadSchemas.ts'
import {
  type ProjectTransferManifest,
  projectTransferPayloadFormatByKey,
  type ProjectTransferPayloadKey,
  projectTransferPayloadKeys,
  projectTransferPayloadPathByKey,
} from './projectTransferSchemas.ts'
import {getProjectTransferImportTempLayout} from './projectTransferSession.ts'
import {
  type ProjectTransferZipJsModule,
  type ProjectTransferZipJsUint8ArrayWriter,
  writeProjectTransferZipPackage,
} from './projectTransferZip.ts'

type PackageOverride = {
  manifest?: (manifest: ProjectTransferManifest) => ProjectTransferManifest
  payloads?: (payloads: ProjectTransferPayloadByKey) => ProjectTransferPayloadByKey
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

const getSerializedPayloads = (payloads: ProjectTransferPayloadByKey) => {
  return projectTransferPayloadKeys.reduce<Record<ProjectTransferPayloadKey, string>>(
    (serialized, key) => {
      return {...serialized, [key]: serializeProjectTransferPayload(key, payloads[key])}
    },
    {} as Record<ProjectTransferPayloadKey, string>,
  )
}

const getManifestPayloads = (
  serializedPayloads: Record<ProjectTransferPayloadKey, string>,
  payloads: ProjectTransferPayloadByKey,
) => {
  return projectTransferPayloadKeys.reduce<ProjectTransferManifest['payloads']>(
    (manifestPayloads, key) => {
      const payload: ProjectTransferPayload = payloads[key]

      return {
        ...manifestPayloads,
        [key]: getProjectTransferManifestPayloadEntry({
          bytes: serializedPayloads[key],
          format: projectTransferPayloadFormatByKey[key],
          path: projectTransferPayloadPathByKey[key],
          recordCount: getPayloadRecordCount(key, payload),
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
  serializedPayloads: Record<ProjectTransferPayloadKey, string>
}) => {
  const manifestInput = {
    assetSummary: {byteLength: assetBytes.byteLength, entryCount: payloads.assetManifest.entries.length},
    exportedAt: '2026-05-26T09:00:00.000Z',
    payloads: getManifestPayloads(serializedPayloads, payloads),
    project: {
      counts: projectTransferPayloadKeys.reduce<Record<ProjectTransferPayloadKey, number>>(
        (counts, key) => {
          const payload: ProjectTransferPayload = payloads[key]

          return {...counts, [key]: getPayloadRecordCount(key, payload)}
        },
        {} as Record<ProjectTransferPayloadKey, number>,
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
  const packageFingerprint = getProjectTransferPackageFingerprint({manifest: unsignedManifest, payloads})
  const manifest = buildProjectTransferManifest({...manifestInput, packageFingerprint})

  return manifestOverride ? manifestOverride(manifest) : manifest
}

const writeAnalyzeUpload = async ({
  cwd,
  manifestOverride,
  payloadOverride,
}: {
  cwd: string
  manifestOverride?: PackageOverride['manifest']
  payloadOverride?: PackageOverride['payloads']
}) => {
  const layout = getProjectTransferImportTempLayout(sessionId)
  const payloads = getFixturePayloads(payloadOverride)
  const serializedPayloads = getSerializedPayloads(payloads)
  const manifest = getManifest({manifestOverride, payloads, serializedPayloads})
  const zipModule = getFakeZipModule()
  const entries = [
    {bytes: getProjectTransferCanonicalJson(manifest), path: 'manifest.json'},
    ...projectTransferPayloadKeys.map((key) => {
      return {bytes: serializedPayloads[key], path: projectTransferPayloadPathByKey[key]}
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
    const {layout, manifest, uploadMetadata, zipModule} = await writeAnalyzeUpload({cwd})
    const result = await analyzeProjectTransferImportPackage({
      availableDiskBytes: 10_000_000_000,
      cwd,
      layout,
      planRevision: 1,
      runner: getEmptyAnalyzeTargetRunner(),
      uploadMetadata,
      zipModule,
    })
    const analysisPath = join(cwd, layout.analysisPath)
    const planPath = join(cwd, layout.planPath)
    const extractedAssetPath = join(cwd, layout.extractedPath, 'assets/project-transfer/session-1/article-1.pdf')
    const planArtifact = JSON.parse(await readFile(planPath, 'utf8')) as {canCommit: boolean; planRevision: number}

    expect(result.planSummary.blockerCount).toBe(0)
    expect(result.planSummary.conflictCounts.packageContractConflictCount).toBe(0)
    expect(result.planSummary.overlapCounts.newArticleCount).toBe(1)
    expect(result.planSummary.packageCounts?.articles).toBe(1)
    expect(result.packageFingerprint).toBe(manifest.packageFingerprint)
    expect(result.plan.canCommit).toBe(true)
    expect(result.analysis.payloads.articles.actualRecordCount).toBe(1)
    expect(planArtifact).toMatchObject({canCommit: true, planRevision: 1})
    expect(existsSync(analysisPath)).toBe(true)
    expect(existsSync(extractedAssetPath)).toBe(true)
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

    expect(result.planSummary.blockerCount).toBe(0)
    expect(result.planSummary.warningCount).toBeGreaterThanOrEqual(1)
    expect(result.planSummary.overlapCounts.reusedArticleCount).toBe(1)
    expect(result.planSummary.overlapCounts.newArticleCount).toBe(0)
    expect(result.planSummary.overlapCounts.reusedArticleUpdateCount).toBe(1)
    expect(result.planSummary.overlapCounts.reusedArticleFieldFillCount).toBe(1)
    expect(result.planSummary.overlapCounts.reusedArticleAssetPromotionCount).toBe(1)
    expect(result.planSummary.overlapCounts.dirtiedExistingProjectCount).toBe(1)
    expect(result.planSummary.overlapCounts.omittedRouteLinkCount).toBe(1)
    expect(result.planSummary.overlapCounts.omittedArticleRouteLinkCount).toBe(1)
    expect(result.planSummary.overlapCounts.routeArticleSnapshotLinkCount).toBe(1)
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
