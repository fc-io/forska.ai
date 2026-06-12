import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs'
import {mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'

import {analyzeProjectTransferImportPackage} from '../src/server/services/projectTransfer/projectTransferAnalyze.ts'
import type {ProjectTransferAnalyzeTargetRunner} from '../src/server/services/projectTransfer/projectTransferAnalyzeTarget.ts'
import {getProjectTransferPackageFingerprint, getProjectTransferSha256Checksum} from '../src/server/services/projectTransfer/projectTransferFingerprint.ts'
import {buildProjectTransferManifest, getProjectTransferManifestPayloadEntry} from '../src/server/services/projectTransfer/projectTransferManifest.ts'
import {
  getProjectTransferPayloadFixtureMap,
  type ProjectTransferPayload,
  type ProjectTransferPayloadByKey,
  serializeProjectTransferPayload,
} from '../src/server/services/projectTransfer/projectTransferPayloadSchemas.ts'
import {
  getProjectTransferPerformanceMetrics,
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

const getEmptyAnalyzeTargetRunner = (): ProjectTransferAnalyzeTargetRunner => {
  return {
    queryJson: async <T>(_statement: string): Promise<T[]> => {
      return []
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

const getBenchmarkArticleSignature = (index: number) => {
  return {identifierKeys: [], title: `Benchmark Article ${index}`}
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

const writeBenchmarkUpload = async ({
  cwd,
  fixture,
}: {
  cwd: string
  fixture: ProjectTransferBenchmarkFixture
}) => {
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

const getBenchmarkMetrics = async (args: ProjectTransferBenchmarkArgs) => {
  const inputMetrics = getMetricsFromRecord(readJsonFile(args.metricsFile)) ?? getMetricsFromRecord(readJsonFile(args.progressFile))

  return inputMetrics ?? (args.fixture === 'article-heavy-package' ? runBenchmarkFixture(args.fixture) : getInputMetrics(args))
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
