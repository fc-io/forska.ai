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
  getProjectTransferPackageFingerprint,
  getProjectTransferSha256Checksum,
} from '../src/server/services/projectTransfer/projectTransferFingerprint.ts'
import {
  buildProjectTransferManifest,
  getProjectTransferManifestPayloadEntry,
} from '../src/server/services/projectTransfer/projectTransferManifest.ts'
import {
  getProjectTransferPayloadFixtureMap,
  type ProjectTransferPayload,
  type ProjectTransferPayloadByKey,
  serializeProjectTransferPayload,
} from '../src/server/services/projectTransfer/projectTransferPayloadSchemas.ts'
import {
  getProjectTransferPerformanceMetrics,
  getProjectTransferPerformanceRowCountersFromPayloads,
  measureProjectTransferPhase,
  projectTransferMetricUnavailable,
  type ProjectTransferPerformanceMetrics,
} from '../src/server/services/projectTransfer/projectTransferPerformanceMetrics.ts'
import {
  type ProjectTransferManifest,
  projectTransferPayloadFormatByKey,
  type ProjectTransferPayloadKey,
  projectTransferPayloadKeys,
  projectTransferPayloadPathByKey,
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
import {writeProjectTransferZipPackage} from '../src/server/services/projectTransfer/projectTransferZip.ts'

type ProjectTransferBenchmarkFixture =
  | 'article-heavy-export'
  | 'article-heavy-package'
  | 'asset-heavy-export'
  | 'asset-heavy-package'
  | 'conflict-heavy-package'
  | 'judgment-heavy-package'
  | 'large-export'
  | 'reuse-heavy-package'
  | 'small-inline'

type ProjectTransferBenchmarkArgs = {
  fixture: ProjectTransferBenchmarkFixture
  metricsFile: string | null
  progressFile: string | null
}

type ProjectTransferBenchmarkPayloadOverride = (payloads: ProjectTransferPayloadByKey) => ProjectTransferPayloadByKey
type ProjectTransferGeneratedBenchmarkMetrics = (
  fixture: ProjectTransferBenchmarkFixture,
) => Promise<ProjectTransferPerformanceMetrics>

const projectTransferBenchmarkFixtures = [
  'small-inline',
  'article-heavy-package',
  'judgment-heavy-package',
  'asset-heavy-package',
  'reuse-heavy-package',
  'conflict-heavy-package',
  'article-heavy-export',
  'asset-heavy-export',
  'large-export',
] as const satisfies readonly ProjectTransferBenchmarkFixture[]

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

const getFixture = (value: string | null): ProjectTransferBenchmarkFixture => {
  return projectTransferBenchmarkFixtures.includes(value as ProjectTransferBenchmarkFixture)
    ? (value as ProjectTransferBenchmarkFixture)
    : 'small-inline'
}

const getArgs = (): ProjectTransferBenchmarkArgs => {
  return {
    fixture: getFixture(getArgValue('--fixture')),
    metricsFile: getArgValue('--metrics-file'),
    progressFile: getArgValue('--progress-file'),
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
      : null
}

const getInputMetrics = (args: ProjectTransferBenchmarkArgs) => {
  return (
    getMetricsFromRecord(readJsonFile(args.metricsFile))
    ?? getMetricsFromRecord(readJsonFile(args.progressFile))
    ?? getProjectTransferPerformanceMetrics({operation: 'import'})
  )
}

const textEncoder = new TextEncoder()
const benchmarkSessionId = 'benchmark-project-transfer-session'
const benchmarkAssetBytes = textEncoder.encode('benchmark-pdf')
const articleHeavyRowCount = 1_000
const assetHeavyAssetCount = 8
const assetHeavyAssetByteLength = 4 * 1024 * 1024
const assetHeavyPromotionConcurrency = 4

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

const getAssetHeavyPromotionAssets = () => {
  return Array.from({length: assetHeavyAssetCount}, (_entry, index) => {
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

const getBenchmarkPayloads = (fixture: ProjectTransferBenchmarkFixture) => {
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

  return fixture === 'article-heavy-package' ? getArticleHeavyPayloads(withAssetChecksum) : withAssetChecksum
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
      const payload = payloads[key]

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

const getBenchmarkManifest = ({
  payloads,
  serializedPayloads,
}: {
  payloads: ProjectTransferPayloadByKey
  serializedPayloads: Record<ProjectTransferPayloadKey, string>
}) => {
  const manifestInput = {
    assetSummary: {byteLength: benchmarkAssetBytes.byteLength, entryCount: payloads.assetManifest.entries.length},
    exportedAt: '2026-06-12T00:00:00.000Z',
    payloads: getManifestPayloads(serializedPayloads, payloads),
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
    sourceAppVersion: '0.2.1',
    warnings: [],
  }
  const unsignedManifest = buildProjectTransferManifest(manifestInput)
  const packageFingerprint = getProjectTransferPackageFingerprint({manifest: unsignedManifest, payloads})

  return buildProjectTransferManifest({...manifestInput, packageFingerprint})
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

const writeBenchmarkUpload = async ({cwd, fixture}: {cwd: string; fixture: ProjectTransferBenchmarkFixture}) => {
  const layout = getProjectTransferImportTempLayout(benchmarkSessionId)
  const payloads = getBenchmarkPayloads(fixture)
  const serializedPayloads = getSerializedPayloads(payloads)
  const manifest = getBenchmarkManifest({payloads, serializedPayloads})
  const entries = [
    {bytes: JSON.stringify(manifest), path: 'manifest.json'},
    ...projectTransferPayloadKeys.map((key) => {
      return {bytes: serializedPayloads[key], path: projectTransferPayloadPathByKey[key]}
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

const getBenchmarkMetricTotal = (
  values: readonly (number | typeof projectTransferMetricUnavailable)[],
) => {
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
        bytesPerSecond: getBenchmarkRatePerSecond({
          durationMs: promotion.timing.durationMs,
          value: assetByteLength,
        }),
        correctnessChecks: {
          assetPromotionReadCount: promotion.value.metrics?.assetReadCount ?? projectTransferMetricUnavailable,
          boundedConcurrency: promotion.value.metrics?.boundedConcurrency ?? projectTransferMetricUnavailable,
          copiedAssetCount: promotion.value.metrics?.copiedAssetCount ?? projectTransferMetricUnavailable,
          promotedAssetRereadCount:
            promotion.value.metrics?.promotedAssetRereadCount ?? projectTransferMetricUnavailable,
          rollbackDeletedPromotedAssetCount: cleanup.value.deletedPromotedAssetCount,
          rollbackSkippedPromotedAssetCount: cleanup.value.skippedPromotedAssetCount,
        },
        finalAssetBytes: assetByteLength,
        packageFingerprint,
        schemaVersion: 1,
        temporaryDiskBytes: assetByteLength * 2,
        wallTimeMs: getBenchmarkMetricTotal([promotion.timing.durationMs, cleanup.timing.durationMs]),
      },
      bytes: {
        assetBytes: assetByteLength,
        assetPromotionBytes: assetByteLength,
      },
      operation: 'import',
      phases: {assetPromotion: promotion.timing, cleanup: cleanup.timing},
      rows: getProjectTransferPerformanceRowCountersFromPayloads(payloads),
    })
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
}

const runBenchmarkFixture = async (fixture: ProjectTransferBenchmarkFixture) => {
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
    const serializedPayloads = getSerializedPayloads(payloads)
    const manifest = getBenchmarkManifest({payloads, serializedPayloads})
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
  Record<ProjectTransferBenchmarkFixture, ProjectTransferGeneratedBenchmarkMetrics>
> = {
  'article-heavy-package': runBenchmarkFixture,
  'asset-heavy-package': runAssetHeavyPromotionBenchmark,
  'reuse-heavy-package': runReuseHeavyRevalidationBenchmark,
}

const getGeneratedBenchmarkMetrics = (args: ProjectTransferBenchmarkArgs) => {
  const generator = generatedBenchmarkMetricsByFixture[args.fixture]

  return generator ? generator(args.fixture) : getInputMetrics(args)
}

const getBenchmarkMetrics = async (args: ProjectTransferBenchmarkArgs) => {
  const inputMetrics =
    getMetricsFromRecord(readJsonFile(args.metricsFile)) ?? getMetricsFromRecord(readJsonFile(args.progressFile))

  return inputMetrics ?? getGeneratedBenchmarkMetrics(args)
}

const getMetricStatus = (metrics: ProjectTransferPerformanceMetrics) => {
  return metrics.benchmark.wallTimeMs === projectTransferMetricUnavailable ? 'metrics_unavailable' : 'ok'
}

const main = async () => {
  const args = getArgs()
  const metrics = await getBenchmarkMetrics(args)

  console.log(
    JSON.stringify({
      benchmark: metrics.benchmark,
      bytes: metrics.bytes,
      fixture: args.fixture,
      generatedAt: new Date().toISOString(),
      machineReadable: true,
      memory: metrics.memory,
      parser: metrics.parser,
      phases: metrics.phases,
      rows: metrics.rows,
      status: getMetricStatus(metrics),
      warnings: metrics.warnings,
    }),
  )
}

await main()
