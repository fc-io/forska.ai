import {setMaxListeners} from 'node:events'
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs'
import {mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'

import {
  analyzeProjectTransferImportPackage,
  type ProjectTransferImportAnalysisArtifact,
  type ProjectTransferImportPlanArtifact,
} from '../src/server/services/projectTransfer/projectTransferAnalyze.ts'
import type {ProjectTransferAnalyzeTargetRunner} from '../src/server/services/projectTransfer/projectTransferAnalyzeTarget.ts'
import {revalidateProjectTransferCommitPlan} from '../src/server/services/projectTransfer/projectTransferCommit.ts'
import {
  promoteProjectTransferCommitAssets,
  rollbackProjectTransferCommitPromotion,
} from '../src/server/services/projectTransfer/projectTransferCommitRollback.ts'
import type {ProjectTransferPlanSummary} from '../src/server/services/projectTransfer/projectTransferContracts.ts'
import {
  getProjectTransferExportAssetCollectionForReferences,
  type ProjectTransferExportAssetReferenceInput,
} from '../src/server/services/projectTransfer/projectTransferExportAssets.ts'
import {
  getProjectTransferPackageFingerprint,
  getProjectTransferSha256Checksum,
} from '../src/server/services/projectTransfer/projectTransferFingerprint.ts'
import {
  buildProjectTransferManifest,
  getProjectTransferManifestPayloadEntry,
} from '../src/server/services/projectTransfer/projectTransferManifest.ts'
import {
  getProjectTransferPayloadFixtureMap,
  getProjectTransferSchemaVNextFingerprintSortKey,
  type ProjectTransferPackagePayloadByKey,
  type ProjectTransferPayload,
  type ProjectTransferPayloadByKey,
  type ProjectTransferPayloadRecord,
  type ProjectTransferSchemaVNextAssetEntryPayloadRecord,
  type ProjectTransferSchemaVNextAssetReferencePayloadRecord,
  serializeProjectTransferPayload,
  serializeProjectTransferPayloadForSchemaVersion,
} from '../src/server/services/projectTransfer/projectTransferPayloadSchemas.ts'
import {
  getProjectTransferPerformanceMetrics,
  getProjectTransferPerformanceRowCountersFromPayloads,
  measureProjectTransferPhase,
  projectTransferMetricUnavailable,
  type ProjectTransferMetricValue,
  type ProjectTransferPerformanceMetrics,
  projectTransferPerformancePhases,
} from '../src/server/services/projectTransfer/projectTransferPerformanceMetrics.ts'
import {
  getProjectTransferPayloadFormatForSchemaVersion,
  getProjectTransferPayloadKeysForSchemaVersion,
  getProjectTransferPayloadPathForSchemaVersion,
  type ProjectTransferManifest,
  projectTransferManifestSchemaVersion,
  type ProjectTransferPackagePayloadKey,
  type ProjectTransferPayloadKey,
  projectTransferPayloadKeys,
  projectTransferPayloadPathByKey,
  type ProjectTransferSchemaVNextPayloadKey,
} from '../src/server/services/projectTransfer/projectTransferSchemas.ts'
import {getProjectTransferImportTempLayout} from '../src/server/services/projectTransfer/projectTransferSession.ts'
import {
  projectTransferDependencyFingerprintAlgorithm,
  projectTransferDependencyFingerprintCodeVersion,
  projectTransferTargetStateCoverageCodeVersion,
  type ProjectTransferTargetStateDirtyTokenSnapshot,
  type ProjectTransferTargetStateSafetySurface,
  projectTransferTargetStateSafetySurfaces,
} from '../src/server/services/projectTransfer/projectTransferTargetStateDirtyTokenService.ts'
import {
  getProjectTransferZipCrc32Digest,
  type ProjectTransferZipEntryInput,
  writeProjectTransferZipPackage,
  writeProjectTransferZipPackageToFile,
} from '../src/server/services/projectTransfer/projectTransferZip.ts'

type ProjectTransferSingleBenchmarkFixture =
  | 'article-heavy-export'
  | 'article-heavy-package'
  | 'asset-heavy-export'
  | 'asset-heavy-package'
  | 'conflict-heavy-package'
  | 'judgment-heavy-package'
  | 'large-export'
  | 'reuse-heavy-package'
  | 'small-inline-package'

type ProjectTransferBenchmarkFixture = ProjectTransferSingleBenchmarkFixture | 'matrix'

type ProjectTransferBenchmarkArgs = {
  baselineFile: string | null
  fixture: ProjectTransferBenchmarkFixture
  metricsFile: string | null
  progressFile: string | null
  runs: number
}

type ProjectTransferBenchmarkPayloadOverride = (payloads: ProjectTransferPayloadByKey) => ProjectTransferPayloadByKey
type ProjectTransferGeneratedBenchmarkMetrics = (
  fixture: ProjectTransferSingleBenchmarkFixture,
) => Promise<ProjectTransferPerformanceMetrics>
type ProjectTransferSerializedPackagePayloads = Partial<Record<ProjectTransferPackagePayloadKey, string>>

const projectTransferSingleBenchmarkFixtures = [
  'small-inline-package',
  'article-heavy-package',
  'judgment-heavy-package',
  'asset-heavy-package',
  'reuse-heavy-package',
  'conflict-heavy-package',
  'article-heavy-export',
  'asset-heavy-export',
  'large-export',
] as const satisfies readonly ProjectTransferSingleBenchmarkFixture[]

const projectTransferMatrixBenchmarkFixtures = [
  'small-inline-package',
  'article-heavy-package',
  'judgment-heavy-package',
  'asset-heavy-package',
  'reuse-heavy-package',
  'conflict-heavy-package',
  'large-export',
] as const satisfies readonly ProjectTransferSingleBenchmarkFixture[]

const getArgValue = (flag: string) => {
  const prefix = `${flag}=`

  return (
    process.argv
      .slice(2)
      .find((argument) => {
        return argument.startsWith(prefix)
      })
      ?.slice(prefix.length) ?? null
  )
}

const getAliasedFixture = (value: string | null): ProjectTransferBenchmarkFixture | undefined => {
  return value === 'all'
    ? 'matrix'
    : value === 'matrix'
      ? 'matrix'
      : value === 'large-export-package'
        ? 'large-export'
        : value === 'small-inline' || value === 'small-inline-package'
          ? 'small-inline-package'
          : undefined
}

const getFixture = (value: string | null): ProjectTransferBenchmarkFixture => {
  const aliased = getAliasedFixture(value)

  return aliased !== undefined
    ? aliased
    : projectTransferSingleBenchmarkFixtures.includes(value as ProjectTransferSingleBenchmarkFixture)
      ? (value as ProjectTransferSingleBenchmarkFixture)
      : 'small-inline-package'
}

const getPositiveIntegerArg = (flag: string, defaultValue: number) => {
  const value = Number(getArgValue(flag))

  return Number.isInteger(value) && value > 0 ? value : defaultValue
}

const getArgs = (): ProjectTransferBenchmarkArgs => {
  const fixture = getFixture(getArgValue('--fixture'))

  return {
    baselineFile: getArgValue('--baseline-file'),
    fixture,
    metricsFile: getArgValue('--metrics-file'),
    progressFile: getArgValue('--progress-file'),
    runs: getPositiveIntegerArg('--runs', fixture === 'matrix' ? 3 : 1),
  }
}

const readJsonFile = (pathValue: string | null) => {
  return pathValue !== null && existsSync(pathValue) ? (JSON.parse(readFileSync(pathValue, 'utf8')) as unknown) : null
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const getMetricsFromRecord = (value: unknown): ProjectTransferPerformanceMetrics | null => {
  return isRecord(value) && isRecord(value.performanceMetrics)
    ? (value.performanceMetrics as ProjectTransferPerformanceMetrics)
    : isRecord(value) && value.version === 1 && isRecord(value.benchmark)
      ? (value as ProjectTransferPerformanceMetrics)
      : isRecord(value)
          && isRecord(value.benchmark)
          && isRecord(value.bytes)
          && isRecord(value.memory)
          && isRecord(value.parser)
          && isRecord(value.phases)
          && isRecord(value.rows)
          && isRecord(value.warnings)
        ? ({
            benchmark: value.benchmark,
            bytes: value.bytes,
            duckdb: {
              spillBytes: value.benchmark.duckdbSpillBytes ?? projectTransferMetricUnavailable,
              writerTransactionMs: value.benchmark.writerTransactionMs ?? projectTransferMetricUnavailable,
            },
            memory: value.memory,
            operation: value.operation === 'export' ? 'export' : 'import',
            parser: value.parser,
            phases: value.phases,
            rows: value.rows,
            version: 1,
            warnings: value.warnings,
          } as ProjectTransferPerformanceMetrics)
        : null
}

const textEncoder = new TextEncoder()
setMaxListeners(0)

const benchmarkSessionId = 'benchmark-project-transfer-session'
const benchmarkAssetBytes = textEncoder.encode('benchmark-pdf')
const articleHeavyRowCount = 1_000
const conflictHeavyRowCount = 400
const judgmentHeavyRowCount = 1_000
const assetHeavyAssetCount = 8
const assetHeavyAssetByteLength = 4 * 1024 * 1024
const assetHeavyPromotionConcurrency = 4
const largeExportAssetCount = 16

const getEmptyAnalyzeTargetRunner = (): ProjectTransferAnalyzeTargetRunner => {
  return {
    queryJson: async <T>(_statement: string): Promise<T[]> => {
      return []
    },
  }
}

const getCompleteTargetStateTokens = () => {
  return projectTransferTargetStateSafetySurfaces.reduce<
    Partial<Record<ProjectTransferTargetStateSafetySurface, number>>
  >((tokens, surface) => {
    return {...tokens, [surface]: 0}
  }, {})
}

const getBenchmarkTargetStateSnapshot = (): ProjectTransferTargetStateDirtyTokenSnapshot => {
  return {
    capturedAt: '2026-06-12T00:00:00.000Z',
    coverage: {
      coverageCodeVersion: projectTransferTargetStateCoverageCodeVersion,
      coveredSurfaces: [...projectTransferTargetStateSafetySurfaces],
      dependencyFingerprintAlgorithm: projectTransferDependencyFingerprintAlgorithm,
      dependencyFingerprintCodeVersion: projectTransferDependencyFingerprintCodeVersion,
      initializedAt: '2026-06-12T00:00:00.000Z',
      updatedAt: '2026-06-12T00:00:00.000Z',
    },
    globalUnknownToken: 0,
    tokens: getCompleteTargetStateTokens(),
  }
}

const getTargetStateSnapshotRunner = (
  snapshot: ProjectTransferTargetStateDirtyTokenSnapshot,
): ProjectTransferAnalyzeTargetRunner => {
  return {
    queryJson: async <T>(statement: string): Promise<T[]> => {
      return statement.includes('project_transfer_target_state_coverage')
        ? ([
            {
              coverageCodeVersion: snapshot.coverage?.coverageCodeVersion ?? null,
              coveredSurfacesJson: snapshot.coverage?.coveredSurfaces ?? [],
              dependencyFingerprintAlgorithm: snapshot.coverage?.dependencyFingerprintAlgorithm ?? null,
              dependencyFingerprintCodeVersion: snapshot.coverage?.dependencyFingerprintCodeVersion ?? null,
              initializedAt: snapshot.coverage?.initializedAt ?? '2026-06-12T00:00:00.000Z',
              updatedAt: snapshot.coverage?.updatedAt ?? '2026-06-12T00:00:00.000Z',
            },
          ] as T[])
        : statement.includes('project_transfer_target_state_unknown_token')
          ? ([{dirtyToken: snapshot.globalUnknownToken}] as T[])
          : statement.includes('project_transfer_target_state_dirty_token')
            ? (Object.entries(snapshot.tokens).map(([surface, dirtyToken]) => {
                return {dirtyToken, surface}
              }) as T[])
            : []
    },
    run: async () => {
      return undefined
    },
  }
}

const getPayloadRecordCount = (key: ProjectTransferPayloadKey, payload: ProjectTransferPayload) => {
  return key === 'project'
    ? 1
    : key === 'assetManifest'
      ? (payload as ProjectTransferPayloadByKey['assetManifest']).entries.length
      : Array.isArray(payload)
        ? payload.length
        : 0
}

const getBenchmarkConflictCounts = () => {
  return {
    articleConflictCount: 0,
    humanReviewFidelityConflictCount: 0,
    judgmentConflictCount: 0,
    packageContractConflictCount: 0,
    projectPromptConflictCount: 0,
  }
}

const getBenchmarkOverlapCounts = () => {
  return {
    currentReviewRowsSignatureHumanReviewCount: 0,
    currentReviewRowsSignatureJudgmentCount: 0,
    dirtiedExistingProjectCount: 0,
    duplicateImportMatchCount: 0,
    newArticleCount: 0,
    omittedArticleRouteLinkCount: 0,
    omittedRouteLinkCount: 0,
    reusedArticleAssetPromotionCount: 0,
    reusedArticleCount: 0,
    reusedArticleFieldFillCount: 0,
    reusedArticleUpdateCount: 0,
    reusedJudgmentCount: 0,
    routeArticleSnapshotLinkCount: 0,
    snapshotVerifiedJudgmentCount: 0,
    storedSignatureHumanReviewCount: 0,
    storedSignatureJudgmentCount: 0,
  }
}

const getBenchmarkPlanSummary = ({
  packageCounts,
  packageFingerprint,
}: {
  packageCounts: Record<ProjectTransferPayloadKey, number>
  packageFingerprint: string
}): ProjectTransferPlanSummary => {
  return {
    blockerCount: 0,
    blockers: [],
    conflictCounts: getBenchmarkConflictCounts(),
    dependencyStatuses: {},
    judgmentConflictStatus: 'clear',
    overlapCounts: getBenchmarkOverlapCounts(),
    packageCounts,
    packageFingerprint,
    packageWarnings: [],
    warningCount: 0,
  }
}

const getBenchmarkArticleSignature = (index: number) => {
  return {identifierKeys: [], title: `Benchmark Article ${index}`}
}

const getAssetHeavyBenchmarkBytes = (index: number) => {
  const bytes = new Uint8Array(assetHeavyAssetByteLength)
  bytes.fill((index % 251) + 1)

  return bytes
}

const getBenchmarkZipEntryMetadata = (bytes: Uint8Array) => {
  return {
    checksumSha256: getProjectTransferSha256Checksum(bytes),
    crc32: getProjectTransferZipCrc32Digest(bytes),
    uncompressedSize: bytes.byteLength,
  }
}

const getAssetHeavyPromotionAssets = (assetCount = assetHeavyAssetCount) => {
  return Array.from({length: assetCount}, (_entry, index) => {
    const bytes = getAssetHeavyBenchmarkBytes(index)

    return {
      byteLength: bytes.byteLength,
      bytes,
      checksumSha256: getProjectTransferSha256Checksum(bytes),
      packagePath: `assets/source/asset-heavy-${String(index + 1).padStart(4, '0')}.pdf`,
    }
  })
}

const getAssetHeavyPayloads = ({
  assets,
  payloads,
}: {
  assets: ReturnType<typeof getAssetHeavyPromotionAssets>
  payloads: ProjectTransferPayloadByKey
}) => {
  const [assetEntry] = payloads.assetManifest.entries

  if (assetEntry === undefined) {
    throw new Error('Project transfer benchmark asset fixture is incomplete')
  }

  return {
    ...payloads,
    assetManifest: {
      ...payloads.assetManifest,
      entries: assets.map((asset, index) => {
        return {
          ...assetEntry,
          byteLength: asset.byteLength,
          checksumSha256: asset.checksumSha256,
          packagePath: asset.packagePath,
          sortKey: `asset-heavy-${String(index + 1).padStart(4, '0')}`,
        }
      }),
    },
  }
}

const getSchemaVNextAssetEntryPayload = (
  entry: ProjectTransferPayloadByKey['assetManifest']['entries'][number],
): ProjectTransferSchemaVNextAssetEntryPayloadRecord => {
  const fingerprint = {checksumSha256: entry.checksumSha256, packagePath: entry.packagePath}
  const contentType = entry.contentType === undefined ? {} : {contentType: entry.contentType}

  return {
    ...contentType,
    byteLength: entry.byteLength,
    checksumSha256: entry.checksumSha256,
    fingerprint,
    packagePath: entry.packagePath,
    sortKey: getProjectTransferSchemaVNextFingerprintSortKey(fingerprint),
  }
}

const getSchemaVNextPayloadKeyByCurrentPayloadPath = (payloadFile: string): ProjectTransferSchemaVNextPayloadKey => {
  const key = projectTransferPayloadKeys.find((payloadKey) => {
    return projectTransferPayloadPathByKey[payloadKey] === payloadFile
  })

  if (key === undefined || key === 'assetManifest') {
    throw new Error(`Project transfer benchmark asset reference has unsupported payload file: ${payloadFile}`)
  }

  return key as ProjectTransferSchemaVNextPayloadKey
}

const getSchemaVNextAssetReferencePayload = ({
  assetPackagePath,
  reference,
}: {
  assetPackagePath: string
  reference: ProjectTransferPayloadByKey['assetManifest']['entries'][number]['references'][number]
}): ProjectTransferSchemaVNextAssetReferencePayloadRecord => {
  const payloadKey = getSchemaVNextPayloadKeyByCurrentPayloadPath(reference.payloadFile)
  const payloadPath = getProjectTransferPayloadPathForSchemaVersion({
    key: payloadKey,
    schemaVersion: projectTransferManifestSchemaVersion,
  })

  if (payloadPath === undefined) {
    throw new Error(`Project transfer benchmark schema ${projectTransferManifestSchemaVersion} disallows ${payloadKey}`)
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

const getSchemaVNextAssetReferencePayloads = (
  assetManifest: ProjectTransferPayloadByKey['assetManifest'],
): ProjectTransferSchemaVNextAssetReferencePayloadRecord[] => {
  return assetManifest.entries.flatMap((entry) => {
    return entry.references.map((reference) => {
      return getSchemaVNextAssetReferencePayload({assetPackagePath: entry.packagePath, reference})
    })
  })
}

const getBenchmarkPackagePayloads = (payloads: ProjectTransferPayloadByKey): ProjectTransferPackagePayloadByKey => {
  return {
    ...payloads,
    assetEntries: payloads.assetManifest.entries.map(getSchemaVNextAssetEntryPayload),
    assetReferences: getSchemaVNextAssetReferencePayloads(payloads.assetManifest),
  }
}

const getArticleHeavyPayloads: ProjectTransferBenchmarkPayloadOverride = (payloads) => {
  const article = payloads.articles[0]
  const projectArticle = payloads.projectArticles[0]
  const articleImportRoute = payloads.articleImportRoutes[0]

  if (article === undefined || projectArticle === undefined || articleImportRoute === undefined) {
    throw new Error('Project transfer benchmark article fixture is incomplete')
  }

  const articles = Array.from({length: articleHeavyRowCount}, (_value, index) => {
    const articleNumber = index + 1
    const sourceArticleId = `benchmark-article-${articleNumber}`
    const signature = getBenchmarkArticleSignature(articleNumber)

    return {
      ...article,
      articleTitle: signature.title,
      arxivId: null,
      biorxivId: null,
      doi: null,
      identifierInputs: [],
      medrxivId: null,
      provenance: {...article.provenance, sourceArticleId},
      pubmedId: null,
      signature,
      sourceArticleId,
      url: null,
    }
  })
  const projectArticles = articles.map((entry, index) => {
    return {
      ...projectArticle,
      provenance: {...projectArticle.provenance, sourceArticleId: entry.sourceArticleId},
      signature: {...projectArticle.signature, articleSignature: entry.signature},
      sourceArticleId: entry.sourceArticleId,
      sourceProjectArticleId: `benchmark-project-article-${index + 1}`,
    }
  })
  const articleImportRoutes = articles.map((entry, index) => {
    return {
      ...articleImportRoute,
      externalArticleId: `BENCH-${index + 1}`,
      provenance: {...articleImportRoute.provenance, sourceArticleId: entry.sourceArticleId},
      signature: {
        ...articleImportRoute.signature,
        articleSignature: entry.signature,
        sourceRecordHash: `benchmark-source-record-hash-${index + 1}`,
      },
      sourceArticleId: entry.sourceArticleId,
      sourceArticleImportRouteId: `benchmark-article-import-route-${index + 1}`,
      sourceRecordHash: `benchmark-source-record-hash-${index + 1}`,
      sourceRecordKey: `benchmark-source-record-key-${index + 1}`,
    }
  })

  return {...payloads, articleImportRoutes, articles, projectArticles}
}

const getJudgmentHeavyJudgment = (judgment: ProjectTransferPayloadRecord, index: number) => {
  const judgmentNumber = index + 1
  const sourceJudgmentId = `benchmark-judgment-${judgmentNumber}`

  return {
    ...judgment,
    provenance: {...judgment.provenance, sourceJudgmentId},
    signature: {...judgment.signature, benchmarkRow: judgmentNumber},
    sourceJudgmentId,
  }
}

const getJudgmentHeavyAssessment = (assessment: ProjectTransferPayloadRecord, index: number) => {
  const judgmentNumber = index + 1
  const sourceJudgmentId = `benchmark-judgment-${judgmentNumber}`

  return {
    ...assessment,
    provenance: {...assessment.provenance, sourceJudgmentId},
    signature: {...assessment.signature, benchmarkRow: judgmentNumber},
    sourceJudgmentAssessmentId: `benchmark-judgment-assessment-${judgmentNumber}`,
    sourceJudgmentId,
  }
}

const getJudgmentHeavyPayloads: ProjectTransferBenchmarkPayloadOverride = (payloads) => {
  const judgment = payloads.judgments[0]
  const assessment = payloads.judgmentAssessments[0]

  if (judgment === undefined || assessment === undefined) {
    throw new Error('Project transfer benchmark judgment fixture is incomplete')
  }

  return {
    ...payloads,
    judgmentAssessments: Array.from({length: judgmentHeavyRowCount}, (_entry, index) => {
      return getJudgmentHeavyAssessment(assessment, index)
    }),
    judgments: Array.from({length: judgmentHeavyRowCount}, (_entry, index) => {
      return getJudgmentHeavyJudgment(judgment, index)
    }),
  }
}

const getConflictHeavyArticle = (
  article: ProjectTransferPayloadByKey['articles'][number],
  index: number,
): ProjectTransferPayloadByKey['articles'][number] => {
  const conflictDoi = 'https://doi.org/10.1101/benchmark-conflict'

  return {
    ...article,
    doi: conflictDoi,
    identifierInputs: [{inputKind: 'doi', source: 'article_identifier', value: conflictDoi}],
    signature: {...article.signature, identifierKeys: ['doi:10.1101/benchmark-conflict']},
    warnings: [
      {
        action: 'review',
        code: 'identifierConflict',
        message: `Benchmark conflict article ${index + 1} shares a DOI`,
        scope: 'articles',
        severity: 'warning',
        sourceRef: `article:${article.sourceArticleId}`,
      },
    ],
  }
}

const getConflictHeavyPayloads: ProjectTransferBenchmarkPayloadOverride = (payloads) => {
  const articlePayloads = getArticleHeavyPayloads(payloads)
  const articles = articlePayloads.articles.slice(0, conflictHeavyRowCount).map(getConflictHeavyArticle)
  const sourceArticleIds = new Set(
    articles.map((article) => {
      return article.sourceArticleId
    }),
  )

  return {
    ...articlePayloads,
    articleImportRoutes: articlePayloads.articleImportRoutes.filter((route) => {
      return typeof route.sourceArticleId === 'string' && sourceArticleIds.has(route.sourceArticleId)
    }),
    articles,
    projectArticles: articlePayloads.projectArticles.filter((projectArticle) => {
      return typeof projectArticle.sourceArticleId === 'string' && sourceArticleIds.has(projectArticle.sourceArticleId)
    }),
  }
}

const getBenchmarkPayloads = (fixture: ProjectTransferSingleBenchmarkFixture) => {
  const payloads = getProjectTransferPayloadFixtureMap()
  const [assetEntry] = payloads.assetManifest.entries

  if (assetEntry === undefined) {
    throw new Error('Project transfer benchmark asset fixture is incomplete')
  }

  const withAssetChecksum = {
    ...payloads,
    assetManifest: {
      ...payloads.assetManifest,
      entries: [
        {
          ...assetEntry,
          byteLength: benchmarkAssetBytes.byteLength,
          checksumSha256: getProjectTransferSha256Checksum(benchmarkAssetBytes),
        },
      ],
    },
  }

  return fixture === 'article-heavy-package'
    ? getArticleHeavyPayloads(withAssetChecksum)
    : fixture === 'judgment-heavy-package'
      ? getJudgmentHeavyPayloads(withAssetChecksum)
      : fixture === 'conflict-heavy-package'
        ? getConflictHeavyPayloads(withAssetChecksum)
        : withAssetChecksum
}

const getBenchmarkPackagePayloadKeys = () => {
  return getProjectTransferPayloadKeysForSchemaVersion(projectTransferManifestSchemaVersion)
}

const getSerializedPackagePayloads = (payloads: ProjectTransferPackagePayloadByKey) => {
  return getBenchmarkPackagePayloadKeys().reduce<ProjectTransferSerializedPackagePayloads>((serialized, key) => {
    return {
      ...serialized,
      [key]: serializeProjectTransferPayloadForSchemaVersion(projectTransferManifestSchemaVersion, key, payloads[key]),
    }
  }, {})
}

const getManifestPayloads = (
  serializedPayloads: ProjectTransferSerializedPackagePayloads,
  payloads: ProjectTransferPackagePayloadByKey,
) => {
  return getBenchmarkPackagePayloadKeys().reduce<ProjectTransferManifest['payloads']>(
    (manifestPayloads, key) => {
      const payload = payloads[key]
      const serializedPayload = serializedPayloads[key]
      const format = getProjectTransferPayloadFormatForSchemaVersion({
        key,
        schemaVersion: projectTransferManifestSchemaVersion,
      })
      const path = getProjectTransferPayloadPathForSchemaVersion({
        key,
        schemaVersion: projectTransferManifestSchemaVersion,
      })

      if (serializedPayload === undefined || format === undefined || path === undefined) {
        throw new Error(`Project transfer benchmark schema ${projectTransferManifestSchemaVersion} disallows ${key}`)
      }

      return {
        ...manifestPayloads,
        [key]: getProjectTransferManifestPayloadEntry({
          bytes: serializedPayload,
          format,
          path,
          recordCount: getPackagePayloadRecordCount(key, payload),
        }),
      }
    },
    {} as ProjectTransferManifest['payloads'],
  )
}

const getBenchmarkManifest = ({
  packagePayloads,
  payloads,
  serializedPayloads,
}: {
  packagePayloads: ProjectTransferPackagePayloadByKey
  payloads: ProjectTransferPayloadByKey
  serializedPayloads: ProjectTransferSerializedPackagePayloads
}) => {
  const manifestInput = {
    assetSummary: {byteLength: benchmarkAssetBytes.byteLength, entryCount: payloads.assetManifest.entries.length},
    exportedAt: '2026-06-12T00:00:00.000Z',
    payloads: getManifestPayloads(serializedPayloads, packagePayloads),
    project: {
      counts: getBenchmarkPackagePayloadKeys().reduce<Partial<Record<ProjectTransferPackagePayloadKey, number>>>(
        (counts, key) => {
          return {...counts, [key]: getPackagePayloadRecordCount(key, packagePayloads[key])}
        },
        {},
      ),
      currentModel: {modelName: 'gpt-5.4', remoteModelId: 'gpt-5.4', sourceModelId: 'model-1'},
      humanJudgmentMode: payloads.project.settings.humanJudgmentMode,
      name: payloads.project.name,
      sourceProjectId: payloads.project.sourceProjectId,
    },
    schemaVersion: projectTransferManifestSchemaVersion,
    sourceAppVersion: '0.2.1',
    warnings: [],
  }
  const unsignedManifest = buildProjectTransferManifest(manifestInput)
  const packageFingerprint = getProjectTransferPackageFingerprint({
    manifest: unsignedManifest,
    payloads: packagePayloads,
  })

  return buildProjectTransferManifest({...manifestInput, packageFingerprint})
}

const getPackagePayloadRecordCount = <TKey extends ProjectTransferPackagePayloadKey>(
  key: TKey,
  payload: ProjectTransferPackagePayloadByKey[TKey],
) => {
  return key === 'project'
    ? 1
    : key === 'assetManifest'
      ? (payload as ProjectTransferPayloadByKey['assetManifest']).entries.length
      : Array.isArray(payload)
        ? payload.length
        : 0
}

const getBenchmarkPackageCounts = (payloads: ProjectTransferPayloadByKey) => {
  return projectTransferPayloadKeys.reduce<Record<ProjectTransferPayloadKey, number>>(
    (counts, key) => {
      return {...counts, [key]: getPayloadRecordCount(key, payloads[key])}
    },
    {} as Record<ProjectTransferPayloadKey, number>,
  )
}

const getBenchmarkTargetPlan = (
  assetPromotionPlan: ProjectTransferImportPlanArtifact['targetPlan']['assetPromotionPlan'] = [],
): ProjectTransferImportPlanArtifact['targetPlan'] => {
  return {
    articleMatches: [],
    articleRoutePlan: [],
    articleUpdatePlan: [],
    assetPromotionPlan,
    duplicateImportMatches: [],
    projectPromptPlan: [],
    projectRoutePlan: [],
    promptPlan: [],
  }
}

const getBenchmarkAnalysisArtifact = ({
  manifest,
  packageCounts,
  packageFingerprint,
  payloads,
}: {
  manifest: ProjectTransferManifest
  packageCounts: Record<ProjectTransferPayloadKey, number>
  packageFingerprint: string
  payloads: ProjectTransferPayloadByKey
}): ProjectTransferImportAnalysisArtifact => {
  return {
    analyzedAt: '2026-06-12T00:00:00.000Z',
    archive: {expandedBytes: 0, memberCount: 0, packageChecksumSha256: '0'.repeat(64), packageSizeBytes: 0},
    assetSummary: {
      actualByteLength: benchmarkAssetBytes.byteLength,
      actualEntryCount: payloads.assetManifest.entries.length,
      manifestByteLength: manifest.assetSummary?.byteLength ?? null,
      manifestEntryCount: manifest.assetSummary?.entryCount ?? null,
    },
    computedPackageFingerprint: packageFingerprint,
    manifest,
    packageCounts,
    packageFingerprint,
    packageWarnings: [],
    payloads: {} as ProjectTransferImportAnalysisArtifact['payloads'],
    planRevision: 1,
  }
}

const getBenchmarkPlanArtifact = ({
  packageCounts,
  packageFingerprint,
  targetPlan,
  targetState,
}: {
  packageCounts: Record<ProjectTransferPayloadKey, number>
  packageFingerprint: string
  targetPlan?: ProjectTransferImportPlanArtifact['targetPlan']
  targetState: ProjectTransferTargetStateDirtyTokenSnapshot
}): ProjectTransferImportPlanArtifact => {
  const summary = getBenchmarkPlanSummary({packageCounts, packageFingerprint})

  return {
    blockers: [],
    canCommit: true,
    packageCounts,
    packageFingerprint,
    packageWarnings: [],
    planRevision: 1,
    resolutionKinds: {},
    summary,
    targetPlan: targetPlan ?? getBenchmarkTargetPlan(),
    targetState,
  }
}

const writeBenchmarkRuntimeFile = async ({
  cwd,
  path,
  value,
}: {
  cwd: string
  path: string
  value: string | Uint8Array
}) => {
  const filePath = join(cwd, path)
  await mkdir(dirname(filePath), {recursive: true})
  await globalThis.Bun.write(filePath, value)
}

const writeBenchmarkUpload = async ({cwd, fixture}: {cwd: string; fixture: ProjectTransferSingleBenchmarkFixture}) => {
  const layout = getProjectTransferImportTempLayout(benchmarkSessionId)
  const payloads = getBenchmarkPayloads(fixture)
  const packagePayloads = getBenchmarkPackagePayloads(payloads)
  const serializedPayloads = getSerializedPackagePayloads(packagePayloads)
  const manifest = getBenchmarkManifest({packagePayloads, payloads, serializedPayloads})
  const entries = [
    {bytes: JSON.stringify(manifest), path: 'manifest.json'},
    ...getBenchmarkPackagePayloadKeys().map((key) => {
      const serializedPayload = serializedPayloads[key]
      const path = getProjectTransferPayloadPathForSchemaVersion({
        key,
        schemaVersion: projectTransferManifestSchemaVersion,
      })

      if (serializedPayload === undefined || path === undefined) {
        throw new Error(`Project transfer benchmark schema ${projectTransferManifestSchemaVersion} disallows ${key}`)
      }

      return {bytes: serializedPayload, path}
    }),
    {
      bytes: benchmarkAssetBytes,
      path: payloads.assetManifest.entries[0]?.packagePath ?? 'assets/project-transfer/session-1/article-1.pdf',
    },
  ]
  const zipPackage = await writeProjectTransferZipPackage({entries})
  const uploadPath = join(cwd, layout.uploadPath)

  await mkdir(dirname(uploadPath), {recursive: true})
  await globalThis.Bun.write(uploadPath, zipPackage.bytes)

  return {
    layout,
    uploadMetadata: {
      byteLength: zipPackage.bytes.byteLength,
      checksumSha256: zipPackage.checksumSha256,
      fileName: 'benchmark.zip',
    },
  }
}

const getAssetHeavyPromotionPlan = ({
  assets,
  payloads,
}: {
  assets: ReturnType<typeof getAssetHeavyPromotionAssets>
  payloads: ProjectTransferPayloadByKey
}): ProjectTransferImportPlanArtifact['targetPlan']['assetPromotionPlan'] => {
  const sourceArticleId = payloads.articles[0]?.sourceArticleId ?? 'benchmark-source-article'

  return assets.map((asset) => {
    return {
      byteLength: asset.byteLength,
      checksumSha256: asset.checksumSha256,
      contentType: 'application/pdf',
      fields: ['fullTextPdf'],
      packagePath: asset.packagePath,
      sourceArticleIds: [sourceArticleId],
      targetArticleIds: [`new:${sourceArticleId}`],
    }
  })
}

const getAssetHeavyExportReferences = (
  assets: ReturnType<typeof getAssetHeavyPromotionAssets>,
): ProjectTransferExportAssetReferenceInput[] => {
  return assets.map((asset, index) => {
    const articleNumber = index + 1

    return {
      assetPath: asset.packagePath,
      fieldPath: `articles[${index}].fullTextPdf`,
      jsonPointer: `/${index}/fullTextPdf`,
      kind: 'fullTextPdf',
      sourceArticleId: `benchmark-export-article-${articleNumber}`,
    }
  })
}

const writeAssetHeavyExportArtifacts = async ({
  assetCount = assetHeavyAssetCount,
  cwd,
}: {
  assetCount?: number
  cwd: string
}) => {
  const assets = getAssetHeavyPromotionAssets(assetCount)

  await Promise.all(
    assets.map((asset) => {
      return writeBenchmarkRuntimeFile({cwd, path: asset.packagePath, value: asset.bytes})
    }),
  )

  return {assets, references: getAssetHeavyExportReferences(assets)}
}

const getAssetHeavyExportPackageAssetEntry = (
  asset: Awaited<ReturnType<typeof getProjectTransferExportAssetCollectionForReferences>>['assetEntries'][number],
): ProjectTransferZipEntryInput => {
  if (!asset.filePath) {
    throw new Error(`Project transfer benchmark export asset is missing a staged file path: ${asset.path}`)
  }

  return {
    filePath: asset.filePath,
    metadata: {checksumSha256: asset.checksumSha256, crc32: asset.crc32, uncompressedSize: asset.byteLength},
    path: asset.path,
  }
}

const getAssetHeavyExportPackageEntries = (
  collection: Awaited<ReturnType<typeof getProjectTransferExportAssetCollectionForReferences>>,
  fixture: ProjectTransferSingleBenchmarkFixture,
) => {
  const manifestBytes = textEncoder.encode(
    JSON.stringify({fixture, schemaVersion: projectTransferManifestSchemaVersion}),
  )

  return [
    {bytes: manifestBytes, metadata: getBenchmarkZipEntryMetadata(manifestBytes), path: 'manifest.json'},
    ...collection.assetEntries.map(getAssetHeavyExportPackageAssetEntry),
  ] satisfies ProjectTransferZipEntryInput[]
}

const writeAssetHeavyPromotionArtifacts = async ({cwd}: {cwd: string}) => {
  const layout = getProjectTransferImportTempLayout(benchmarkSessionId)
  const assets = getAssetHeavyPromotionAssets()
  const payloads = getAssetHeavyPayloads({assets, payloads: getBenchmarkPayloads('asset-heavy-package')})
  const packageCounts = getBenchmarkPackageCounts(payloads)
  const packageFingerprint = 'asset-heavy-package-promotion'
  const targetState = getBenchmarkTargetStateSnapshot()
  const plan = getBenchmarkPlanArtifact({
    packageCounts,
    packageFingerprint,
    targetPlan: getBenchmarkTargetPlan(getAssetHeavyPromotionPlan({assets, payloads})),
    targetState,
  })

  await Promise.all([
    writeBenchmarkRuntimeFile({cwd, path: layout.planPath, value: JSON.stringify(plan)}),
    writeBenchmarkRuntimeFile({
      cwd,
      path: `${layout.extractedPath}/${projectTransferPayloadPathByKey.articles}`,
      value: serializeProjectTransferPayload('articles', payloads.articles),
    }),
    ...assets.map((asset) => {
      return writeBenchmarkRuntimeFile({cwd, path: `${layout.extractedPath}/${asset.packagePath}`, value: asset.bytes})
    }),
  ])

  return {assets, layout, packageFingerprint, payloads}
}

const getBenchmarkRatePerSecond = ({
  durationMs,
  value,
}: {
  durationMs: number | typeof projectTransferMetricUnavailable
  value: number | typeof projectTransferMetricUnavailable
}) => {
  return typeof durationMs === 'number' && durationMs > 0 && typeof value === 'number'
    ? Number((value / (durationMs / 1000)).toFixed(2))
    : projectTransferMetricUnavailable
}

const getBenchmarkMetricTotal = (values: readonly (number | typeof projectTransferMetricUnavailable)[]) => {
  const knownValues = values.filter((value): value is number => {
    return typeof value === 'number'
  })

  return knownValues.length === 0
    ? projectTransferMetricUnavailable
    : knownValues.reduce((total, value) => {
        return total + value
      }, 0)
}

const runAssetHeavyPromotionBenchmark = async () => {
  const cwd = mkdtempSync(join(tmpdir(), `f2-project-transfer-asset-promotion-benchmark-${process.pid}-`))

  try {
    const {assets, layout, packageFingerprint, payloads} = await writeAssetHeavyPromotionArtifacts({cwd})
    const promotion = await measureProjectTransferPhase('assetPromotion', () => {
      return promoteProjectTransferCommitAssets({
        cwd,
        layout,
        maxConcurrency: assetHeavyPromotionConcurrency,
        now: new Date('2026-06-12T00:00:00.000Z'),
        sessionId: benchmarkSessionId,
      })
    })
    const cleanup = await measureProjectTransferPhase('cleanup', () => {
      return rollbackProjectTransferCommitPromotion({
        cwd,
        manifest: promotion.value.manifest,
        sessionId: benchmarkSessionId,
      })
    })
    const assetByteLength =
      promotion.value.metrics?.assetByteLength
      ?? assets.reduce((total, asset) => {
        return total + asset.byteLength
      }, 0)

    return getProjectTransferPerformanceMetrics({
      benchmark: {
        bytesPerSecond: getBenchmarkRatePerSecond({durationMs: promotion.timing.durationMs, value: assetByteLength}),
        correctnessChecks: {
          activeAssetCopyBufferBytes: assetHeavyPromotionConcurrency * assetHeavyAssetByteLength,
          assetPromotionReadCount: promotion.value.metrics?.assetReadCount ?? projectTransferMetricUnavailable,
          boundedConcurrency: promotion.value.metrics?.boundedConcurrency ?? projectTransferMetricUnavailable,
          copiedAssetCount: promotion.value.metrics?.copiedAssetCount ?? projectTransferMetricUnavailable,
          memoryBoundedByActiveBuffers: true,
          promotedAssetRereadCount:
            promotion.value.metrics?.promotedAssetRereadCount ?? projectTransferMetricUnavailable,
          rollbackDeletedPromotedAssetCount: cleanup.value.deletedPromotedAssetCount,
          rollbackSkippedPromotedAssetCount: cleanup.value.skippedPromotedAssetCount,
        },
        finalAssetBytes: assetByteLength,
        packageFingerprint,
        schemaVersion: projectTransferManifestSchemaVersion,
        temporaryDiskBytes: assetByteLength * 2,
        wallTimeMs: getBenchmarkMetricTotal([promotion.timing.durationMs, cleanup.timing.durationMs]),
      },
      bytes: {assetBytes: assetByteLength, assetPromotionBytes: assetByteLength},
      operation: 'import',
      phases: {assetPromotion: promotion.timing, cleanup: cleanup.timing},
      rows: getProjectTransferPerformanceRowCountersFromPayloads(payloads),
    })
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
}

const runAssetHeavyExportBenchmarkWithOptions = async ({
  assetCount,
  fixture,
}: {
  assetCount: number
  fixture: ProjectTransferSingleBenchmarkFixture
}) => {
  const cwd = mkdtempSync(join(tmpdir(), `f2-project-transfer-asset-export-benchmark-${process.pid}-`))

  try {
    const {assets, references} = await writeAssetHeavyExportArtifacts({assetCount, cwd})
    const stagingRootPath = join(cwd, 'tmp/project-transfer/asset-heavy-export-build')
    const collection = await measureProjectTransferPhase('exportAssembly', () => {
      return getProjectTransferExportAssetCollectionForReferences(references, {
        cwd,
        maxConcurrency: assetHeavyPromotionConcurrency,
        stagingRootPath,
      })
    })
    const packageOutputPath = join(cwd, 'tmp/project-transfer/asset-heavy-export.zip')
    const packageWrite = await measureProjectTransferPhase('exportPackageWrite', () => {
      return writeProjectTransferZipPackageToFile({
        entries: getAssetHeavyExportPackageEntries(collection.value, fixture),
        outputPath: packageOutputPath,
      })
    })
    const assetByteLength = collection.value.assetEntries.reduce((total, asset) => {
      return total + asset.byteLength
    }, 0)
    const wallTimeMs = getBenchmarkMetricTotal([collection.timing.durationMs, packageWrite.timing.durationMs])

    return getProjectTransferPerformanceMetrics({
      benchmark: {
        bytesPerSecond: getBenchmarkRatePerSecond({
          durationMs: packageWrite.timing.durationMs,
          value: packageWrite.value.byteLength,
        }),
        correctnessChecks: {
          activeAssetCopyBufferBytes: assetHeavyPromotionConcurrency * assetHeavyAssetByteLength,
          assetCopyBytesPerSecond: getBenchmarkRatePerSecond({
            durationMs: collection.timing.durationMs,
            value: assetByteLength,
          }),
          boundedConcurrency: assetHeavyPromotionConcurrency,
          copiedAssetCount: collection.value.assetEntries.length,
          memoryBoundedByActiveBuffers: true,
          packageChecksumSha256: packageWrite.value.checksumSha256,
          sourceAssetCount: assets.length,
          stagedManifestEntryCount: collection.value.assetManifest.entries.length,
          zipEntryCount: packageWrite.value.entries.length,
        },
        finalAssetBytes: assetByteLength,
        packageFingerprint: fixture,
        peakMemoryBytes: packageWrite.timing.sampledPeakMemoryBytes,
        schemaVersion: projectTransferManifestSchemaVersion,
        temporaryDiskBytes: assetByteLength + packageWrite.value.byteLength,
        wallTimeMs,
      },
      bytes: {
        assetBytes: assetByteLength,
        exportAssetCopyBytes: assetByteLength,
        packageBytes: packageWrite.value.byteLength,
      },
      operation: 'export',
      phases: {exportAssembly: collection.timing, exportPackageWrite: packageWrite.timing},
      rows: {assetEntries: collection.value.assetEntries.length, assetReferences: references.length},
    })
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
}

const runAssetHeavyExportBenchmark = async () => {
  return runAssetHeavyExportBenchmarkWithOptions({assetCount: assetHeavyAssetCount, fixture: 'asset-heavy-export'})
}

const runLargeExportBenchmark = async () => {
  return runAssetHeavyExportBenchmarkWithOptions({assetCount: largeExportAssetCount, fixture: 'large-export'})
}

const runBenchmarkFixture = async (fixture: ProjectTransferSingleBenchmarkFixture) => {
  const cwd = mkdtempSync(join(tmpdir(), `f2-project-transfer-benchmark-${process.pid}-`))

  try {
    const {layout, uploadMetadata} = await writeBenchmarkUpload({cwd, fixture})
    const result = await analyzeProjectTransferImportPackage({
      availableDiskBytes: 10_000_000_000,
      cwd,
      layout,
      planRevision: 1,
      runner: getEmptyAnalyzeTargetRunner(),
      uploadMetadata,
    })

    return result.analysis.performanceMetrics ?? getProjectTransferPerformanceMetrics({operation: 'import'})
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
}

const runReuseHeavyRevalidationBenchmark = async () => {
  const cwd = mkdtempSync(join(tmpdir(), `f2-project-transfer-revalidation-benchmark-${process.pid}-`))

  try {
    const payloads = getArticleHeavyPayloads(getBenchmarkPayloads('reuse-heavy-package'))
    const packagePayloads = getBenchmarkPackagePayloads(payloads)
    const serializedPayloads = getSerializedPackagePayloads(packagePayloads)
    const manifest = getBenchmarkManifest({packagePayloads, payloads, serializedPayloads})
    const packageCounts = getBenchmarkPackageCounts(payloads)
    const packageFingerprint = manifest.packageFingerprint ?? 'reuse-heavy-package'
    const targetState = getBenchmarkTargetStateSnapshot()
    const plan = getBenchmarkPlanArtifact({packageCounts, packageFingerprint, targetState})
    const analysis = getBenchmarkAnalysisArtifact({manifest, packageCounts, packageFingerprint, payloads})
    const layout = getProjectTransferImportTempLayout(benchmarkSessionId)
    const revalidation = await measureProjectTransferPhase('revalidation', () => {
      return revalidateProjectTransferCommitPlan({
        analysis,
        cwd,
        layout,
        nextPlanRevision: 2,
        plan,
        repositories: {analyzeTargetRunner: getTargetStateSnapshotRunner(targetState)},
      })
    })

    return getProjectTransferPerformanceMetrics({
      benchmark: {
        conflictShape: plan.summary.conflictCounts,
        packageFingerprint,
        revalidationOutcome: {changed: revalidation.value.changed, ready: revalidation.value.ready},
        schemaVersion: manifest.schemaVersion,
        wallTimeMs: revalidation.timing.durationMs,
      },
      operation: 'import',
      phases: {revalidation: revalidation.timing},
      rows: getProjectTransferPerformanceRowCountersFromPayloads(payloads),
    })
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
}

const generatedBenchmarkMetricsByFixture: Partial<
  Record<ProjectTransferSingleBenchmarkFixture, ProjectTransferGeneratedBenchmarkMetrics>
> = {
  'article-heavy-package': runBenchmarkFixture,
  'asset-heavy-export': runAssetHeavyExportBenchmark,
  'asset-heavy-package': runAssetHeavyPromotionBenchmark,
  'conflict-heavy-package': runBenchmarkFixture,
  'judgment-heavy-package': runBenchmarkFixture,
  'large-export': runLargeExportBenchmark,
  'reuse-heavy-package': runReuseHeavyRevalidationBenchmark,
  'small-inline-package': runBenchmarkFixture,
}

const getGeneratedBenchmarkMetrics = (fixture: ProjectTransferSingleBenchmarkFixture) => {
  const generator = generatedBenchmarkMetricsByFixture[fixture]

  return generator ? generator(fixture) : getProjectTransferPerformanceMetrics({operation: 'import'})
}

const getBenchmarkMetrics = async (
  args: ProjectTransferBenchmarkArgs,
  fixture: ProjectTransferSingleBenchmarkFixture,
) => {
  const inputMetrics =
    getMetricsFromRecord(readJsonFile(args.metricsFile)) ?? getMetricsFromRecord(readJsonFile(args.progressFile))

  return inputMetrics ?? getGeneratedBenchmarkMetrics(fixture)
}

const getMetricStatus = (metrics: ProjectTransferPerformanceMetrics) => {
  return metrics.benchmark.wallTimeMs === projectTransferMetricUnavailable ? 'metrics_unavailable' : 'ok'
}

const getBenchmarkOutput = ({
  fixture,
  generatedAt,
  metrics,
}: {
  fixture: ProjectTransferSingleBenchmarkFixture
  generatedAt: string
  metrics: ProjectTransferPerformanceMetrics
}) => {
  return {
    benchmark: metrics.benchmark,
    bytes: metrics.bytes,
    fixture,
    generatedAt,
    machineReadable: true,
    memory: metrics.memory,
    operation: metrics.operation,
    parser: metrics.parser,
    phases: metrics.phases,
    rows: metrics.rows,
    status: getMetricStatus(metrics),
    warnings: metrics.warnings,
  }
}

const isKnownBenchmarkMetric = (value: ProjectTransferMetricValue): value is number => {
  return typeof value === 'number' && Number.isFinite(value)
}

const getMedianBenchmarkMetric = (values: readonly ProjectTransferMetricValue[]): ProjectTransferMetricValue => {
  const knownValues = values.filter(isKnownBenchmarkMetric).sort((left, right) => {
    return left - right
  })
  const middleIndex = Math.floor(knownValues.length / 2)
  const lowerValue = knownValues[middleIndex - 1]
  const upperValue = knownValues[middleIndex]

  return knownValues.length === 0
    ? projectTransferMetricUnavailable
    : knownValues.length % 2 === 0 && lowerValue !== undefined && upperValue !== undefined
      ? Number(((lowerValue + upperValue) / 2).toFixed(2))
      : (upperValue ?? projectTransferMetricUnavailable)
}

const getWorstWallTimeMetrics = (runs: readonly ProjectTransferPerformanceMetrics[]) => {
  return runs.reduce<ProjectTransferPerformanceMetrics | null>((worstRun, run) => {
    const runWallTime = run.benchmark.wallTimeMs
    const worstWallTime = worstRun?.benchmark.wallTimeMs

    return isKnownBenchmarkMetric(runWallTime)
      && (!isKnownBenchmarkMetric(worstWallTime ?? projectTransferMetricUnavailable) || runWallTime > worstWallTime)
      ? run
      : worstRun
  }, null)
}

const getMedianPhaseTimes = (runs: readonly ProjectTransferPerformanceMetrics[]) => {
  return projectTransferPerformancePhases.reduce<Record<string, ProjectTransferMetricValue>>((phaseTimes, phase) => {
    return {
      ...phaseTimes,
      [phase]: getMedianBenchmarkMetric(
        runs.map((run) => {
          return run.phases[phase].durationMs
        }),
      ),
    }
  }, {})
}

const getPhaseTimes = (metrics: ProjectTransferPerformanceMetrics | null) => {
  return projectTransferPerformancePhases.reduce<Record<string, ProjectTransferMetricValue>>((phaseTimes, phase) => {
    return {...phaseTimes, [phase]: metrics?.phases[phase].durationMs ?? projectTransferMetricUnavailable}
  }, {})
}

const getMedianBenchmarkFields = (runs: readonly ProjectTransferPerformanceMetrics[]) => {
  return {
    bytesPerSecond: getMedianBenchmarkMetric(
      runs.map((run) => {
        return run.benchmark.bytesPerSecond
      }),
    ),
    duckdbSpillBytes: getMedianBenchmarkMetric(
      runs.map((run) => {
        return run.benchmark.duckdbSpillBytes
      }),
    ),
    finalAssetBytes: getMedianBenchmarkMetric(
      runs.map((run) => {
        return run.benchmark.finalAssetBytes
      }),
    ),
    peakMemoryBytes: getMedianBenchmarkMetric(
      runs.map((run) => {
        return run.benchmark.peakMemoryBytes
      }),
    ),
    rowsPerSecond: getMedianBenchmarkMetric(
      runs.map((run) => {
        return run.benchmark.rowsPerSecond
      }),
    ),
    temporaryDiskBytes: getMedianBenchmarkMetric(
      runs.map((run) => {
        return run.benchmark.temporaryDiskBytes
      }),
    ),
    wallTimeMs: getMedianBenchmarkMetric(
      runs.map((run) => {
        return run.benchmark.wallTimeMs
      }),
    ),
    writerTransactionMs: getMedianBenchmarkMetric(
      runs.map((run) => {
        return run.benchmark.writerTransactionMs
      }),
    ),
  }
}

const getBenchmarkFields = (metrics: ProjectTransferPerformanceMetrics | null) => {
  return {
    bytesPerSecond: metrics?.benchmark.bytesPerSecond ?? projectTransferMetricUnavailable,
    duckdbSpillBytes: metrics?.benchmark.duckdbSpillBytes ?? projectTransferMetricUnavailable,
    finalAssetBytes: metrics?.benchmark.finalAssetBytes ?? projectTransferMetricUnavailable,
    peakMemoryBytes: metrics?.benchmark.peakMemoryBytes ?? projectTransferMetricUnavailable,
    rowsPerSecond: metrics?.benchmark.rowsPerSecond ?? projectTransferMetricUnavailable,
    temporaryDiskBytes: metrics?.benchmark.temporaryDiskBytes ?? projectTransferMetricUnavailable,
    wallTimeMs: metrics?.benchmark.wallTimeMs ?? projectTransferMetricUnavailable,
    writerTransactionMs: metrics?.benchmark.writerTransactionMs ?? projectTransferMetricUnavailable,
  }
}

const getWarningDetailsValidated = (metrics: ProjectTransferPerformanceMetrics) => {
  const benchmarkWarningCount = metrics.benchmark.warningDetails.reduce((total, warning) => {
    return total + warning.count
  }, 0)

  return benchmarkWarningCount === metrics.warnings.total
}

const getBenchmarkMetadata = (metrics: ProjectTransferPerformanceMetrics | null) => {
  return {
    dependencyExecutionSignature: metrics?.benchmark.dependencyExecutionSignature ?? projectTransferMetricUnavailable,
    packageFingerprint: metrics?.benchmark.packageFingerprint ?? projectTransferMetricUnavailable,
    rawArticleProvenanceMode: metrics?.benchmark.rawArticleProvenanceMode ?? projectTransferMetricUnavailable,
    schemaVersion: metrics?.benchmark.schemaVersion ?? projectTransferMetricUnavailable,
  }
}

const getComparisonPercent = ({
  after,
  before,
  higherIsBetter,
}: {
  after: ProjectTransferMetricValue
  before: ProjectTransferMetricValue
  higherIsBetter: boolean
}) => {
  return isKnownBenchmarkMetric(after) && isKnownBenchmarkMetric(before) && before > 0
    ? Number((((higherIsBetter ? after - before : before - after) / before) * 100).toFixed(2))
    : projectTransferMetricUnavailable
}

const getBaselineMetricsFromMatrix = (
  baseline: unknown,
  fixture: ProjectTransferSingleBenchmarkFixture,
): ProjectTransferPerformanceMetrics | null => {
  if (!isRecord(baseline)) {
    return null
  }

  const matrix = baseline.matrix
  const fixtures: unknown[] = isRecord(matrix) && Array.isArray(matrix.fixtures) ? matrix.fixtures : []
  const fixtureRecord = fixtures.find((entry) => {
    return isRecord(entry) && entry.fixture === fixture
  })
  const rawRuns: unknown[] =
    isRecord(fixtureRecord) && Array.isArray(fixtureRecord.rawRuns) ? fixtureRecord.rawRuns : []
  const rawRunMetrics = rawRuns.map(getMetricsFromRecord).find((metrics) => {
    return metrics !== null
  })

  return rawRunMetrics ?? null
}

const getBaselineMetrics = (
  baseline: unknown,
  fixture: ProjectTransferSingleBenchmarkFixture,
): ProjectTransferPerformanceMetrics | null => {
  const matrixMetrics = getBaselineMetricsFromMatrix(baseline, fixture)

  return matrixMetrics ?? getMetricsFromRecord(baseline)
}

const getFixtureMatrixSummary = ({
  baselineMetrics,
  fixture,
  runs,
}: {
  baselineMetrics: ProjectTransferPerformanceMetrics | null
  fixture: ProjectTransferSingleBenchmarkFixture
  runs: readonly ProjectTransferPerformanceMetrics[]
}) => {
  const worstRun = getWorstWallTimeMetrics(runs)
  const medianFields = getMedianBenchmarkFields(runs)
  const baselineFields = getBenchmarkFields(baselineMetrics)

  return {
    after: {
      median: {...medianFields, phaseTimes: getMedianPhaseTimes(runs)},
      worstRun: {
        benchmark: getBenchmarkFields(worstRun),
        conflictShape: worstRun?.benchmark.conflictShape ?? projectTransferMetricUnavailable,
        correctnessChecks: worstRun?.benchmark.correctnessChecks ?? projectTransferMetricUnavailable,
        metadata: getBenchmarkMetadata(worstRun),
        phaseTimes: getPhaseTimes(worstRun),
        revalidationOutcome: worstRun?.benchmark.revalidationOutcome ?? projectTransferMetricUnavailable,
        warningDetails: worstRun?.benchmark.warningDetails ?? [],
        warningTotal: worstRun?.warnings.total ?? projectTransferMetricUnavailable,
      },
    },
    before: {
      benchmark: baselineFields,
      metadata: getBenchmarkMetadata(baselineMetrics),
      phaseTimes: getPhaseTimes(baselineMetrics),
    },
    checks: {
      bytesPerSecondImprovementPercent: getComparisonPercent({
        after: medianFields.bytesPerSecond,
        before: baselineFields.bytesPerSecond,
        higherIsBetter: true,
      }),
      jsHeapBoundedByActiveBatchAndAssetBuffers: runs.every((run) => {
        const checks = run.benchmark.correctnessChecks

        return !isRecord(checks) || checks.memoryBoundedByActiveBuffers === true
      }),
      rowsPerSecondImprovementPercent: getComparisonPercent({
        after: medianFields.rowsPerSecond,
        before: baselineFields.rowsPerSecond,
        higherIsBetter: true,
      }),
      smallPackageLatencyRegressionPercent:
        fixture === 'small-inline-package'
          ? getComparisonPercent({
              after: medianFields.wallTimeMs,
              before: baselineFields.wallTimeMs,
              higherIsBetter: false,
            })
          : projectTransferMetricUnavailable,
      warningDetailsValidated: runs.every(getWarningDetailsValidated),
      writerTransactionDurationDeltaPercent: getComparisonPercent({
        after: medianFields.writerTransactionMs,
        before: baselineFields.writerTransactionMs,
        higherIsBetter: false,
      }),
    },
    fixture,
    runCount: runs.length,
    status: runs.every((run) => {
      return getMetricStatus(run) === 'ok'
    })
      ? 'ok'
      : 'metrics_unavailable',
  }
}

const runFixtureIterations = async ({
  args,
  fixture,
}: {
  args: ProjectTransferBenchmarkArgs
  fixture: ProjectTransferSingleBenchmarkFixture
}) => {
  return Array.from({length: args.runs}).reduce<Promise<ProjectTransferPerformanceMetrics[]>>(async (previousRuns) => {
    const runs = await previousRuns
    const metrics = await getBenchmarkMetrics(args, fixture)

    return [...runs, metrics]
  }, Promise.resolve([]))
}

const runMatrixBenchmark = async (args: ProjectTransferBenchmarkArgs) => {
  const generatedAt = new Date().toISOString()
  const baseline = readJsonFile(args.baselineFile)
  const fixtures = await projectTransferMatrixBenchmarkFixtures.reduce<
    Promise<{rawRuns: ReturnType<typeof getBenchmarkOutput>[]; summary: ReturnType<typeof getFixtureMatrixSummary>}[]>
  >(async (previousFixtures, fixture) => {
    const fixtureSummaries = await previousFixtures
    const runs = await runFixtureIterations({args, fixture})
    const rawRuns = runs.map((metrics) => {
      return getBenchmarkOutput({fixture, generatedAt, metrics})
    })
    const summary = getFixtureMatrixSummary({baselineMetrics: getBaselineMetrics(baseline, fixture), fixture, runs})

    return [...fixtureSummaries, {rawRuns, summary}]
  }, Promise.resolve([]))

  return {
    generatedAt,
    machineReadable: true,
    matrix: {
      fixtures: fixtures.map((fixture) => {
        return {...fixture.summary, rawRuns: fixture.rawRuns}
      }),
      runCountPerFixture: args.runs,
    },
    status: fixtures.every((fixture) => {
      return fixture.summary.status === 'ok'
    })
      ? 'ok'
      : 'metrics_unavailable',
  }
}

const runSingleBenchmark = async (
  args: ProjectTransferBenchmarkArgs,
  fixture: ProjectTransferSingleBenchmarkFixture,
) => {
  const metrics = await getBenchmarkMetrics(args, fixture)

  return getBenchmarkOutput({fixture, generatedAt: new Date().toISOString(), metrics})
}

const main = async () => {
  const args = getArgs()
  const output =
    args.fixture === 'matrix' ? await runMatrixBenchmark(args) : await runSingleBenchmark(args, args.fixture)

  console.log(JSON.stringify(output))
}

await main()
