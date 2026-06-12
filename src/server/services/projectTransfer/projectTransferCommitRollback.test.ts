import {mkdtempSync, rmSync} from 'node:fs'
import {mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'

import {afterAll, expect, test} from 'bun:test'

import type {ProjectTransferImportPlanArtifact} from './projectTransferAnalyze.ts'
import type {ProjectTransferTargetPlan} from './projectTransferAnalyzeTarget.ts'
import {
  type ProjectTransferCommitPromotionManifest,
  promoteProjectTransferCommitAssets,
  runProjectTransferCommitWithPromotionRollback,
} from './projectTransferCommitRollback.ts'
import {getProjectTransferCanonicalJson, getProjectTransferSha256Checksum} from './projectTransferFingerprint.ts'
import {
  resolveProjectTransferArchiveMemberWritablePath,
  resolveProjectTransferPromotionWritablePath,
  resolveProjectTransferTempWritablePath,
} from './projectTransferPaths.ts'
import type {ProjectTransferArticlePayloadRecord} from './projectTransferPayloadSchemas.ts'
import {projectTransferPayloadKeys, projectTransferPayloadPathByKey} from './projectTransferSchemas.ts'
import {getProjectTransferImportTempLayout} from './projectTransferSession.ts'

const runtimeRoot = mkdtempSync(join(tmpdir(), 'f2-project-transfer-commit-rollback-'))
const textEncoder = new TextEncoder()
const now = new Date('2026-05-28T12:00:00.000Z')

afterAll(() => {
  rmSync(runtimeRoot, {force: true, recursive: true})
})

const getBytes = (value: string) => {
  return textEncoder.encode(value)
}

const writeFileValue = async (pathValue: string, value: string | Uint8Array) => {
  await mkdir(dirname(pathValue), {recursive: true})
  await globalThis.Bun.write(pathValue, value)
}

const writeTempJson = async (pathValue: string, value: unknown) => {
  return writeFileValue(
    resolveProjectTransferTempWritablePath({cwd: runtimeRoot, pathValue}),
    getProjectTransferCanonicalJson(value),
  )
}

const writeExtractedAsset = async (sessionId: string, packagePath: string, bytes: Uint8Array) => {
  const layout = getProjectTransferImportTempLayout(sessionId)

  return writeFileValue(
    resolveProjectTransferArchiveMemberWritablePath({
      archiveMemberPath: packagePath,
      cwd: runtimeRoot,
      extractionRootPath: layout.extractedPath,
    }),
    bytes,
  )
}

const writeArticles = async (sessionId: string, articles: ProjectTransferArticlePayloadRecord[]) => {
  const layout = getProjectTransferImportTempLayout(sessionId)
  const articlesText = articles
    .map((article) => {
      return JSON.stringify(article)
    })
    .join('\n')

  return writeFileValue(
    resolveProjectTransferTempWritablePath({
      cwd: runtimeRoot,
      pathValue: `${layout.extractedPath}/${projectTransferPayloadPathByKey.articles}`,
    }),
    `${articlesText}\n`,
  )
}

const getPackageCounts = () => {
  return projectTransferPayloadKeys.reduce<Record<string, number>>((counts, key) => {
    return {...counts, [key]: 0}
  }, {})
}

const getPlan = ({
  articleMatches,
  articleUpdatePlan = [],
  assetPromotionPlan,
}: {
  articleMatches: ProjectTransferTargetPlan['articleMatches']
  articleUpdatePlan?: ProjectTransferTargetPlan['articleUpdatePlan']
  assetPromotionPlan: ProjectTransferTargetPlan['assetPromotionPlan']
}): ProjectTransferImportPlanArtifact => {
  const packageCounts = getPackageCounts() as ProjectTransferImportPlanArtifact['packageCounts']
  const summary = {
    blockerCount: 0,
    conflictCounts: {
      articleConflictCount: 0,
      humanReviewFidelityConflictCount: 0,
      judgmentConflictCount: 0,
      packageContractConflictCount: 0,
      projectPromptConflictCount: 0,
    },
    dependencyStatuses: {},
    judgmentConflictStatus: 'clear' as const,
    overlapCounts: {
      currentReviewRowsSignatureHumanReviewCount: 0,
      currentReviewRowsSignatureJudgmentCount: 0,
      dirtiedExistingProjectCount: 0,
      duplicateImportMatchCount: 0,
      newArticleCount: articleMatches.length,
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
    },
    packageCounts,
    packageFingerprint: null,
    packageWarnings: [],
    warningCount: 0,
  }

  return {
    blockers: [],
    canCommit: true,
    packageCounts,
    packageFingerprint: null,
    packageWarnings: [],
    planRevision: 1,
    resolutionKinds: {},
    summary,
    targetPlan: {
      articleMatches,
      articleRoutePlan: [],
      articleUpdatePlan,
      assetPromotionPlan,
      duplicateImportMatches: [],
      projectPromptPlan: [],
      projectRoutePlan: [],
      promptPlan: [],
    },
  }
}

const writePlan = async (sessionId: string, plan: ProjectTransferImportPlanArtifact) => {
  return writeTempJson(getProjectTransferImportTempLayout(sessionId).planPath, plan)
}

const getArticle = (
  sourceArticleId: string,
  fields: Partial<ProjectTransferArticlePayloadRecord>,
): ProjectTransferArticlePayloadRecord => {
  return {
    articleTitle: `Article ${sourceArticleId}`,
    identifierInputs: [],
    provenance: {sourceArticleId},
    signature: {identifierKeys: [], title: `Article ${sourceArticleId}`},
    sourceArticleId,
    ...fields,
  }
}

const getAssetPromotionPlanEntry = ({
  contentType,
  packagePath,
  sourceArticleId = 'source-article-1',
  targetArticleId = 'new:source-article-1',
  bytes,
}: {
  bytes: Uint8Array
  contentType: string
  packagePath: string
  sourceArticleId?: string
  targetArticleId?: string
}): ProjectTransferTargetPlan['assetPromotionPlan'][number] => {
  return {
    byteLength: bytes.byteLength,
    checksumSha256: getProjectTransferSha256Checksum(bytes),
    contentType,
    fields: ['fullTextAssets', 'fullTextHtml', 'fullTextPdf'],
    packagePath,
    sourceArticleIds: [sourceArticleId],
    targetArticleIds: [targetArticleId],
  }
}

const fileExists = async (pathValue: string) => {
  return globalThis.Bun.file(resolveProjectTransferPromotionWritablePath({cwd: runtimeRoot, pathValue})).exists()
}

const readPromotionManifest = async (sessionId: string) => {
  const layout = getProjectTransferImportTempLayout(sessionId)
  const text = await globalThis.Bun.file(
    resolveProjectTransferTempWritablePath({cwd: runtimeRoot, pathValue: layout.promotionManifestPath}),
  ).text()

  return JSON.parse(text) as ProjectTransferCommitPromotionManifest
}

test('project transfer commit promotion copies frozen-plan assets and rewrites committed article fields', async () => {
  const sessionId = 'session-promote-assets'
  const pdfPath = 'assets/source/report.pdf'
  const imagePath = 'assets/source/figure.png'
  const imageCopyPath = 'assets/source/figure-copy.png'
  const unplannedPath = 'assets/source/unplanned.png'
  const pdfBytes = getBytes('pdf bytes')
  const imageBytes = getBytes('same image bytes')
  const unplannedBytes = getBytes('unplanned bytes')
  const article = getArticle('source-article-1', {
    fullTextAssets: {images: [imagePath, imageCopyPath], label: 'Figure A'},
    fullTextHtml: `<p><img src="${imagePath}"><a href="https://example.com/article">external</a><embed src='${pdfPath}'></p>`,
    fullTextPdf: pdfPath,
  })
  const plan = getPlan({
    articleMatches: [
      {
        action: 'create',
        candidates: [],
        conflicts: [],
        identifierKeys: [],
        packageArticleId: null,
        selectedTargetArticleId: null,
        sourceArticleId: 'source-article-1',
      },
    ],
    assetPromotionPlan: [
      getAssetPromotionPlanEntry({bytes: pdfBytes, contentType: 'application/pdf', packagePath: pdfPath}),
      getAssetPromotionPlanEntry({bytes: imageBytes, contentType: 'image/png', packagePath: imagePath}),
      getAssetPromotionPlanEntry({bytes: imageBytes, contentType: 'image/png', packagePath: imageCopyPath}),
    ],
  })

  await Promise.all([
    writeExtractedAsset(sessionId, pdfPath, pdfBytes),
    writeExtractedAsset(sessionId, imagePath, imageBytes),
    writeExtractedAsset(sessionId, imageCopyPath, imageBytes),
    writeExtractedAsset(sessionId, unplannedPath, unplannedBytes),
    writeArticles(sessionId, [article]),
    writePlan(sessionId, plan),
  ])

  const result = await promoteProjectTransferCommitAssets({cwd: runtimeRoot, now, sessionId})
  const promotedPaths = Object.values(result.promotionPathByPackagePath)
  const rewrittenArticle = result.articleCreates[0]?.article
  const rewrittenAssets = rewrittenArticle?.fullTextAssets as {images: string[]; label: string}
  const manifest = await readPromotionManifest(sessionId)

  expect(result.manifest.promotions).toHaveLength(3)
  expect(
    result.manifest.promotions.every((entry) => {
      return entry.copied && entry.copiedChecksumSha256 !== null
    }),
  ).toBe(true)
  expect(
    result.manifest.promotions.map((entry) => {
      return entry.packagePath
    }),
  ).not.toContain(unplannedPath)
  expect(
    promotedPaths.every((pathValue) => {
      return pathValue.startsWith(`assets/project-transfer/${sessionId}/`)
    }),
  ).toBe(true)
  expect(
    promotedPaths.some((pathValue) => {
      return pathValue.includes('report') || pathValue.includes('figure')
    }),
  ).toBe(false)
  expect(
    new Set([result.promotionPathByPackagePath[imagePath], result.promotionPathByPackagePath[imageCopyPath]]).size,
  ).toBe(2)
  expect(rewrittenArticle?.fullTextPdf).toBe(result.promotionPathByPackagePath[pdfPath])
  expect(rewrittenAssets).toEqual({
    images: [result.promotionPathByPackagePath[imagePath], result.promotionPathByPackagePath[imageCopyPath]],
    label: 'Figure A',
  })
  expect(rewrittenArticle?.fullTextHtml).toContain(`src="${result.promotionPathByPackagePath[imagePath]}"`)
  expect(rewrittenArticle?.fullTextHtml).toContain(`src='${result.promotionPathByPackagePath[pdfPath]}'`)
  expect(rewrittenArticle?.fullTextHtml).toContain('href="https://example.com/article"')
  expect(await Promise.all(promotedPaths.map(fileExists))).toEqual(
    promotedPaths.map(() => {
      return true
    }),
  )
  expect(
    manifest.promotions.map((entry) => {
      return entry.copiedChecksumSha256
    }),
  ).toEqual(
    result.manifest.promotions.map((entry) => {
      return entry.checksumSha256
    }),
  )
  expect(result.metrics).toEqual({
    assetByteLength: pdfBytes.byteLength + imageBytes.byteLength + imageBytes.byteLength,
    assetReadCount: 3,
    boundedConcurrency: 3,
    copiedAssetCount: 3,
    promotedAssetRereadCount: 0,
  })
})

test('project transfer commit promotion preserves bounded-concurrency pending state when a copy fails', async () => {
  const sessionId = 'session-bounded-promotion-state'
  const invalidIndex = 2
  const assets = Array.from({length: 6}, (_entry, index) => {
    const expectedText = `bounded expected asset ${index}`
    const expectedBytes = getBytes(expectedText)

    return {
      actualBytes: index === invalidIndex ? getBytes(expectedText.replace('asset', 'bsset')) : expectedBytes,
      expectedBytes,
      packagePath: `assets/source/bounded-${index}.pdf`,
    }
  })
  const article = getArticle('source-article-bounded', {fullTextAssets: null, fullTextHtml: null, fullTextPdf: null})
  const plan = getPlan({
    articleMatches: [],
    assetPromotionPlan: assets.map((asset) => {
      return getAssetPromotionPlanEntry({
        bytes: asset.expectedBytes,
        contentType: 'application/pdf',
        packagePath: asset.packagePath,
      })
    }),
  })

  await Promise.all([
    ...assets.map((asset) => {
      return writeExtractedAsset(sessionId, asset.packagePath, asset.actualBytes)
    }),
    writeArticles(sessionId, [article]),
    writePlan(sessionId, plan),
  ])

  const error: unknown = await promoteProjectTransferCommitAssets({
    cwd: runtimeRoot,
    maxConcurrency: 2,
    now,
    sessionId,
  }).then(
    () => {
      return null
    },
    (caught: unknown) => {
      return caught
    },
  )
  const manifest = await readPromotionManifest(sessionId)
  const invalidPromotion = manifest.promotions.find((entry) => {
    return entry.packagePath === assets[invalidIndex]?.packagePath
  })

  expect(error).toBeInstanceOf(Error)
  expect(error instanceof Error ? error.message : '').toContain('extracted asset checksum mismatch')
  expect(manifest.promotions).toHaveLength(assets.length)
  expect(
    manifest.promotions.map((entry) => {
      return entry.packagePath
    }),
  ).toEqual(
    assets.map((asset) => {
      return asset.packagePath
    }),
  )
  expect(invalidPromotion?.copied).toBe(false)
  expect(invalidPromotion?.copiedAt).toBeNull()
  expect(invalidPromotion?.copiedByteLength).toBeNull()
  expect(invalidPromotion?.copiedChecksumSha256).toBeNull()
  expect(await fileExists(invalidPromotion?.promotedPath ?? '')).toBe(false)
  expect(
    manifest.promotions
      .filter((entry) => {
        return entry.copied
      })
      .every((entry) => {
        return entry.copiedByteLength === entry.byteLength && entry.copiedChecksumSha256 === entry.checksumSha256
      }),
  ).toBe(true)
})

test('project transfer commit promotion rejects source runtime asset URLs in committed article fields', async () => {
  const sessionId = 'session-source-runtime-url'
  const article = getArticle('source-article-runtime-url', {
    fullTextAssets: null,
    fullTextHtml: '<p><img src="/api/runtime-asset?path=assets/source/report.pdf"></p>',
    fullTextPdf: null,
  })
  const plan = getPlan({
    articleMatches: [
      {
        action: 'create',
        candidates: [],
        conflicts: [],
        identifierKeys: [],
        packageArticleId: null,
        selectedTargetArticleId: null,
        sourceArticleId: 'source-article-runtime-url',
      },
    ],
    assetPromotionPlan: [],
  })

  await Promise.all([writeArticles(sessionId, [article]), writePlan(sessionId, plan)])

  const error: unknown = await promoteProjectTransferCommitAssets({cwd: runtimeRoot, now, sessionId}).then(
    () => {
      return null
    },
    (caught: unknown) => {
      return caught
    },
  )

  expect(error).toBeInstanceOf(Error)
  expect(error instanceof Error ? error.message : '').toContain('source runtime asset URL')
})

test('project transfer commit promotion refuses destination collisions without overwriting', async () => {
  const sessionId = 'session-destination-collision'
  const pdfPath = 'assets/source/colliding.pdf'
  const pdfBytes = getBytes('collision pdf bytes')
  const checksumSha256 = getProjectTransferSha256Checksum(pdfBytes)
  const collisionPath = `assets/project-transfer/${sessionId}/asset-000001-${checksumSha256.slice(0, 16)}.pdf`
  const article = getArticle('source-article-collision', {
    fullTextAssets: null,
    fullTextHtml: null,
    fullTextPdf: pdfPath,
  })
  const plan = getPlan({
    articleMatches: [
      {
        action: 'create',
        candidates: [],
        conflicts: [],
        identifierKeys: [],
        packageArticleId: null,
        selectedTargetArticleId: null,
        sourceArticleId: 'source-article-collision',
      },
    ],
    assetPromotionPlan: [
      getAssetPromotionPlanEntry({
        bytes: pdfBytes,
        contentType: 'application/pdf',
        packagePath: pdfPath,
        sourceArticleId: 'source-article-collision',
        targetArticleId: 'new:source-article-collision',
      }),
    ],
  })

  await Promise.all([
    writeExtractedAsset(sessionId, pdfPath, pdfBytes),
    writeArticles(sessionId, [article]),
    writePlan(sessionId, plan),
    writeFileValue(
      resolveProjectTransferPromotionWritablePath({cwd: runtimeRoot, pathValue: collisionPath}),
      getBytes('preexisting file'),
    ),
  ])

  const error: unknown = await promoteProjectTransferCommitAssets({cwd: runtimeRoot, now, sessionId}).then(
    () => {
      return null
    },
    (caught: unknown) => {
      return caught
    },
  )
  const collisionText = await globalThis.Bun.file(
    resolveProjectTransferPromotionWritablePath({cwd: runtimeRoot, pathValue: collisionPath}),
  ).text()

  expect(error).toBeInstanceOf(Error)
  expect(error instanceof Error ? error.message : '').toContain('promotion destination already exists')
  expect(collisionText).toBe('preexisting file')
})

test('project transfer commit rollback deletes only promoted files for failed database work', async () => {
  const sessionId = 'session-rollback-db-failure'
  const otherSessionPath = 'assets/project-transfer/session-rollback-other/asset-000001-other.pdf'
  const pdfPath = 'assets/source/rollback.pdf'
  const pdfBytes = getBytes('rollback pdf bytes')
  const article = getArticle('source-article-rollback', {
    fullTextAssets: null,
    fullTextHtml: null,
    fullTextPdf: pdfPath,
  })
  const plan = getPlan({
    articleMatches: [
      {
        action: 'create',
        candidates: [],
        conflicts: [],
        identifierKeys: [],
        packageArticleId: null,
        selectedTargetArticleId: null,
        sourceArticleId: 'source-article-rollback',
      },
    ],
    assetPromotionPlan: [
      getAssetPromotionPlanEntry({
        bytes: pdfBytes,
        contentType: 'application/pdf',
        packagePath: pdfPath,
        sourceArticleId: 'source-article-rollback',
        targetArticleId: 'new:source-article-rollback',
      }),
    ],
  })
  const state = {workCalled: false}

  await Promise.all([
    writeExtractedAsset(sessionId, pdfPath, pdfBytes),
    writeArticles(sessionId, [article]),
    writePlan(sessionId, plan),
    writeFileValue(
      resolveProjectTransferPromotionWritablePath({cwd: runtimeRoot, pathValue: otherSessionPath}),
      getBytes('other session'),
    ),
  ])

  const error: unknown = await runProjectTransferCommitWithPromotionRollback({
    cwd: runtimeRoot,
    now,
    sessionId,
    work: async () => {
      state.workCalled = true
      throw new Error('database failed after promotion')
    },
  }).then(
    () => {
      return null
    },
    (caught: unknown) => {
      return caught
    },
  )
  const manifest = await readPromotionManifest(sessionId)
  const promotedPath = manifest.promotions[0]?.promotedPath ?? ''

  expect(state.workCalled).toBe(true)
  expect(error).toBeInstanceOf(Error)
  expect(error instanceof Error ? error.message : '').toBe('database failed after promotion')
  expect(await fileExists(promotedPath)).toBe(false)
  expect(await fileExists(otherSessionPath)).toBe(true)
})
