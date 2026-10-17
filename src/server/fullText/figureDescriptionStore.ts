import {getJsonSqlLiteral} from '../providers/providerDbUtils.ts'
import {providerImageInputUnsupportedCode, providerImageTooLargeCode} from '../providers/providerImageInput.ts'
import {
  appendArticleReviewServingDeltas,
  getArticleReviewServingMutationValueHash,
} from '../reviewServing/articleReviewServingDeltaService.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {escapeSqlString, getJsonValue, getSqlLiteral, getTimestampLiteral} from '../services/appQueryHelpers.ts'
import {getUserConfigQueryService} from '../services/userConfigQueryService.ts'
import {HttpError} from '../utils/httpError.ts'
import {createRateLimitedLogger} from '../utils/rateLimitedLogger.ts'
import {
  type FigureDescriptionAsset,
  type FigureDescriptionTarget,
  getAssetWithoutFigureDescription,
  getDescribedFigureAsset,
  getFailedFigureAsset,
  getFigureDescriptionAssetState,
  getFigureDescriptionCounts,
  isFigureDescriptionAsset,
  MAX_FIGURE_DESCRIPTION_ATTEMPTS,
} from './figureDescriptionAssets.ts'
import {
  describeFigure,
  FIGURE_DESCRIPTION_PROMPT_VERSION,
  figureDescriptionInputInvalidCode,
} from './figureDescriptions.ts'
import {figureImageEncodingInvalidCode} from './figureImageEncoding.ts'

type DuckdbWorkloadContext = Parameters<ReturnType<typeof getAppDatabaseService>['transaction']>[1]

type StoredFigureArticle = {assets: string | null; canonicalHash: string | null; conversionStatus: string | null}

type FigureDescriptionCandidateRow = {articleId: string; assetJson: string; canonicalHash: string | null}

export type FigureDescriptionCandidate = {
  articleId: string
  asset: FigureDescriptionAsset
  canonicalHash: string | null
}

export type FigureDescriptionOutcome = 'described' | 'failed' | 'retry' | 'stale'

export type EnsureFigureDescriptionsResult = {
  articleId: string
  described: number
  failed: number
  missing: number
  pending: number
  total: number
}

const figureDescriptionLogger = createRateLimitedLogger({sink: 'file-only', windowMs: 30_000})
const figureDescriptionWarningLogger = createRateLimitedLogger({sink: 'both', windowMs: 30_000})
const figureDescriptionComponent = 'figureDescriptions'
const permanentFailureCodes = new Set([
  'ENOENT',
  'EISDIR',
  figureDescriptionInputInvalidCode,
  figureImageEncodingInvalidCode,
  providerImageInputUnsupportedCode,
  providerImageTooLargeCode,
])
const figureDescriptionsInFlight = new Map<string, Promise<FigureDescriptionOutcome>>()
const articleAssetWriteChains = new Map<string, Promise<unknown>>()

export const figureDescriptionWorkloadContext = {
  fallbackIntent: 'reject' as const,
  routeOrJobKey: 'fullText.figureDescriptions',
  workloadClass: 'background.fullText.figureDescriptions',
}

export const getFigureDescriptionTarget = async (): Promise<FigureDescriptionTarget | null> => {
  const config = await getUserConfigQueryService().getFigureDescriptionModelConfig()

  return config ? {modelId: config.modelId, promptVersion: FIGURE_DESCRIPTION_PROMPT_VERSION} : null
}

const requireFigureDescriptionTarget = async (): Promise<FigureDescriptionTarget> => {
  const target = await getFigureDescriptionTarget()

  if (!target) {
    throw new HttpError(409, 'No figure-description model is configured. Set it in Settings.')
  }

  return target
}

const getErrorCode = (error: unknown): string | null => {
  const code = typeof error === 'object' && error !== null ? (error as {code?: unknown}).code : null

  return typeof code === 'string' ? code : null
}

export const isPermanentFigureDescriptionFailure = (error: unknown): boolean => {
  return permanentFailureCodes.has(getErrorCode(error) ?? '')
}

const getErrorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error)
}

const getStoredFigureAssets = (assetsText: string | null): FigureDescriptionAsset[] => {
  const assets = assetsText === null ? [] : getJsonValue(assetsText)

  return Array.isArray(assets) ? assets.filter(isFigureDescriptionAsset) : []
}

const getDescriptionTargetPredicateSql = (assetSql: string, target: FigureDescriptionTarget) => {
  const modelId = getSqlLiteral(target.modelId)
  const promptVersion = getSqlLiteral(target.promptVersion)

  return `
    NOT (
      NULLIF(TRIM(json_extract_string(${assetSql}, '$.description')), '') IS NOT NULL
      AND json_extract_string(${assetSql}, '$.descriptionModelId') = ${modelId}
      AND json_extract_string(${assetSql}, '$.descriptionPromptVersion') = ${promptVersion}
    )
    AND NOT (
      json_extract_string(${assetSql}, '$.descriptionAttemptModelId') = ${modelId}
      AND json_extract_string(${assetSql}, '$.descriptionAttemptPromptVersion') = ${promptVersion}
      AND COALESCE(TRY_CAST(json_extract(${assetSql}, '$.descriptionAttempts') AS INTEGER), 0) >= ${MAX_FIGURE_DESCRIPTION_ATTEMPTS}
    )
  `
}

export const getFigureDescriptionCandidateSql = ({limit, target}: {limit: number; target: FigureDescriptionTarget}) => {
  return `
    WITH description_project AS (
      SELECT p.id, p.date_from, p.date_to
      FROM app.project p
      WHERE p.full_text_figure_mode = 'descriptions'
        AND COALESCE(p.use_fulltext, FALSE) = TRUE
        AND COALESCE(p.archived, FALSE) = FALSE
    ),
    description_article AS (
      SELECT pa.article_id AS article_id
      FROM description_project dp
      INNER JOIN app.project_article pa ON pa.project_id = dp.id
      INNER JOIN app.article a ON a.id = pa.article_id
      WHERE (dp.date_from IS NULL OR a.article_created_at >= dp.date_from)
        AND (dp.date_to IS NULL OR a.article_created_at <= dp.date_to)
      UNION
      SELECT air.article_id AS article_id
      FROM description_project dp
      INNER JOIN app.project_import_route pir ON pir.project_id = dp.id
      INNER JOIN app.article_import_route air ON air.import_route_id = pir.import_route_id
      INNER JOIN app.article a ON a.id = air.article_id
      WHERE (dp.date_from IS NULL OR a.article_created_at >= dp.date_from)
        AND (dp.date_to IS NULL OR a.article_created_at <= dp.date_to)
    ),
    candidate_asset AS (
      SELECT
        a.id AS articleId,
        a.full_text_canonical_hash AS canonicalHash,
        asset.value AS asset,
        TRY_CAST(json_extract(asset.value, '$.index') AS INTEGER) AS figureIndex
      FROM app.article a
      INNER JOIN description_article da ON da.article_id = a.id
      CROSS JOIN json_each(a.full_text_assets) asset
      WHERE a.full_text_conversion_status = 'success'
        AND a.full_text_assets IS NOT NULL
    )
    SELECT articleId, canonicalHash, CAST(asset AS VARCHAR) AS assetJson
    FROM candidate_asset
    WHERE ${getDescriptionTargetPredicateSql('asset', target)}
    ORDER BY articleId ASC, figureIndex ASC
    LIMIT ${limit}
  `
}

const getFigureKey = (articleId: string, asset: FigureDescriptionAsset, target: FigureDescriptionTarget) => {
  return `${articleId}|${asset.index}|${target.modelId}|${target.promptVersion}`
}

export const selectFigureDescriptionCandidates = async ({
  limit,
  target,
}: {
  limit: number
  target: FigureDescriptionTarget
}): Promise<FigureDescriptionCandidate[]> => {
  const rows = await getAppDatabaseService().queryJsonBackground<FigureDescriptionCandidateRow>(
    getFigureDescriptionCandidateSql({limit, target}),
    {...figureDescriptionWorkloadContext, maxResultRows: limit},
  )

  return rows.flatMap((row) => {
    const asset = getJsonValue(row.assetJson)

    return isFigureDescriptionAsset(asset)
      && getFigureDescriptionAssetState(asset, target) === 'needed'
      && !figureDescriptionsInFlight.has(getFigureKey(row.articleId, asset, target))
      ? [{articleId: row.articleId, asset, canonicalHash: row.canonicalHash}]
      : []
  })
}

const withArticleAssetWriteLock = async <T>(articleId: string, operation: () => Promise<T>): Promise<T> => {
  const previous = articleAssetWriteChains.get(articleId) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(operation)

  articleAssetWriteChains.set(articleId, next)

  return next.finally(() => {
    if (articleAssetWriteChains.get(articleId) === next) {
      articleAssetWriteChains.delete(articleId)
    }
  })
}

const getStoredFigureArticleSql = (articleId: string) => {
  return `
    SELECT
      CAST(full_text_assets AS VARCHAR) AS assets,
      full_text_canonical_hash AS canonicalHash,
      full_text_conversion_status AS conversionStatus
    FROM app.article
    WHERE id = '${escapeSqlString(articleId)}'
    LIMIT 1
  `
}

const updateStoredFigureAsset = async ({
  articleId,
  asset,
  canonicalHash,
  describedValueHash,
  getNextAsset,
  workloadContext,
}: {
  articleId: string
  asset: FigureDescriptionAsset
  canonicalHash: string | null
  describedValueHash: string | null
  getNextAsset: (current: FigureDescriptionAsset) => FigureDescriptionAsset
  workloadContext?: DuckdbWorkloadContext
}): Promise<FigureDescriptionAsset | null> => {
  return withArticleAssetWriteLock(articleId, () => {
    return getAppDatabaseService().transaction(async (tx) => {
      const [article] = await tx.queryJson<StoredFigureArticle>(getStoredFigureArticleSql(articleId))
      const assets = getStoredFigureAssets(article?.assets ?? null)
      const position = assets.findIndex((stored) => {
        return stored.index === asset.index && stored.imagePath === asset.imagePath
      })
      const current = position < 0 || article?.canonicalHash !== canonicalHash ? null : assets[position]

      if (!current) {
        return null
      }

      const sourceUpdatedAt = new Date()
      const nextAsset = getNextAsset(current)

      await tx.run(`
        UPDATE app.article
        SET full_text_assets = ${getJsonSqlLiteral(assets.with(position, nextAsset))}
            ${describedValueHash ? `, updated_at = ${getTimestampLiteral(sourceUpdatedAt)}` : ''}
        WHERE id = '${escapeSqlString(articleId)}'
      `)

      if (describedValueHash) {
        await appendArticleReviewServingDeltas(tx, {
          articleId,
          changedFields: ['fullText'],
          sourceMutationKey: `figureDescriptions|article|${articleId}|figure|${asset.index}|${sourceUpdatedAt.toISOString()}|${describedValueHash}`,
          sourceOperation: 'update',
          sourceUpdatedAt,
        })
      }

      return nextAsset
    }, workloadContext)
  })
}

const storeFigureDescription = async ({
  candidate,
  description,
  target,
  workloadContext,
}: {
  candidate: FigureDescriptionCandidate
  description: string
  target: FigureDescriptionTarget
  workloadContext?: DuckdbWorkloadContext
}): Promise<FigureDescriptionOutcome> => {
  const stored = await updateStoredFigureAsset({
    articleId: candidate.articleId,
    asset: candidate.asset,
    canonicalHash: candidate.canonicalHash,
    describedValueHash: getArticleReviewServingMutationValueHash({description, index: candidate.asset.index, target}),
    getNextAsset: (current) => {
      return getDescribedFigureAsset({asset: current, describedAt: new Date(), description, target})
    },
    workloadContext,
  })

  return stored ? 'described' : 'stale'
}

const storeFigureDescriptionFailure = async ({
  candidate,
  error,
  target,
  workloadContext,
}: {
  candidate: FigureDescriptionCandidate
  error: unknown
  target: FigureDescriptionTarget
  workloadContext?: DuckdbWorkloadContext
}): Promise<FigureDescriptionOutcome> => {
  const permanent = isPermanentFigureDescriptionFailure(error)
  const errorMessage = getErrorMessage(error)
  const failedAsset = await updateStoredFigureAsset({
    articleId: candidate.articleId,
    asset: candidate.asset,
    canonicalHash: candidate.canonicalHash,
    describedValueHash: null,
    getNextAsset: (current) => {
      return getFailedFigureAsset({asset: current, error: errorMessage, failedAt: new Date(), permanent, target})
    },
    workloadContext,
  })
  const outcome: FigureDescriptionOutcome = !failedAsset
    ? 'stale'
    : getFigureDescriptionAssetState(failedAsset, target) === 'failed'
      ? 'failed'
      : 'retry'

  figureDescriptionWarningLogger.warn(
    `figureDescriptions:figure:${outcome}`,
    `[figureDescriptions] Figure description ${outcome === 'failed' ? 'failed' : 'will retry'}`,
    {
      articleId: candidate.articleId,
      attempts: failedAsset?.descriptionAttempts ?? null,
      component: figureDescriptionComponent,
      errorMessage,
      figureIndex: candidate.asset.index,
      modelId: target.modelId,
      outcome,
    },
  )

  return outcome
}

const runFigureDescription = async ({
  candidate,
  cwd,
  target,
  workloadContext,
}: {
  candidate: FigureDescriptionCandidate
  cwd?: string
  target: FigureDescriptionTarget
  workloadContext?: DuckdbWorkloadContext
}): Promise<FigureDescriptionOutcome> => {
  const startedAt = Date.now()
  const result = await describeFigure({
    caption: candidate.asset.caption,
    cwd,
    imagePath: candidate.asset.imagePath,
    model: {modelId: target.modelId},
  }).then(
    (value) => {
      return {error: null, value}
    },
    (error: unknown) => {
      return {error, value: null}
    },
  )
  const outcome = result.value
    ? await storeFigureDescription({candidate, description: result.value.description, target, workloadContext})
    : await storeFigureDescriptionFailure({candidate, error: result.error, target, workloadContext})

  figureDescriptionLogger.log('figureDescriptions:figureFinished', '[figureDescriptions] Figure finished', {
    articleId: candidate.articleId,
    completionTokens: result.value?.usage.completionTokens ?? null,
    component: figureDescriptionComponent,
    durationMs: Date.now() - startedAt,
    figureIndex: candidate.asset.index,
    modelId: target.modelId,
    outcome,
  })

  return outcome
}

export const describeFigureCandidate = async ({
  candidate,
  cwd,
  target,
  workloadContext = figureDescriptionWorkloadContext,
}: {
  candidate: FigureDescriptionCandidate
  cwd?: string
  target: FigureDescriptionTarget
  workloadContext?: DuckdbWorkloadContext
}): Promise<FigureDescriptionOutcome> => {
  const key = getFigureKey(candidate.articleId, candidate.asset, target)
  const existing = figureDescriptionsInFlight.get(key)
  const run =
    existing
    ?? runFigureDescription({candidate, cwd, target, workloadContext}).finally(() => {
      figureDescriptionsInFlight.delete(key)
    })

  figureDescriptionsInFlight.set(key, run)

  return run
}

const runFigureDescriptionWorker = async ({
  candidates,
  cwd,
  outcomes,
  target,
}: {
  candidates: FigureDescriptionCandidate[]
  cwd?: string
  outcomes: FigureDescriptionOutcome[]
  target: FigureDescriptionTarget
}): Promise<FigureDescriptionOutcome[]> => {
  const candidate = candidates.shift()

  return candidate
    ? runFigureDescriptionWorker({
        candidates,
        cwd,
        outcomes: [...outcomes, await describeFigureCandidate({candidate, cwd, target})],
        target,
      })
    : outcomes
}

export const describeFigureCandidates = async ({
  candidates,
  concurrency,
  cwd,
  target,
}: {
  candidates: FigureDescriptionCandidate[]
  concurrency: number
  cwd?: string
  target: FigureDescriptionTarget
}): Promise<FigureDescriptionOutcome[]> => {
  const queue = candidates.slice()
  const workerOutcomes = await Promise.all(
    Array.from({length: Math.max(1, Math.min(concurrency, candidates.length))}, () => {
      return runFigureDescriptionWorker({candidates: queue, cwd, outcomes: [], target})
    }),
  )

  return workerOutcomes.flat()
}

const readStoredFigureArticle = async (articleId: string): Promise<StoredFigureArticle | null> => {
  const [article] = await getAppDatabaseService().queryJsonBackground<StoredFigureArticle>(
    getStoredFigureArticleSql(articleId),
    {...figureDescriptionWorkloadContext, maxResultRows: 1},
  )

  return article ?? null
}

const getArticleFigureCandidates = (articleId: string, article: StoredFigureArticle | null) => {
  return article?.conversionStatus === 'success'
    ? getStoredFigureAssets(article.assets).map((asset) => {
        return {articleId, asset, canonicalHash: article.canonicalHash}
      })
    : []
}

export const getFigureDescriptionCountsForArticle = async ({
  articleId,
  target,
}: {
  articleId: string
  target: FigureDescriptionTarget
}) => {
  const candidates = getArticleFigureCandidates(articleId, await readStoredFigureArticle(articleId))

  return getFigureDescriptionCounts(
    candidates.map((candidate) => {
      return candidate.asset
    }),
    target,
  )
}

export const ensureFigureDescriptions = async (
  articleId: string,
  {concurrency = 1, cwd}: {concurrency?: number; cwd?: string} = {},
): Promise<EnsureFigureDescriptionsResult> => {
  const target = await requireFigureDescriptionTarget()
  const neededCandidates = getArticleFigureCandidates(articleId, await readStoredFigureArticle(articleId)).filter(
    (candidate) => {
      return getFigureDescriptionAssetState(candidate.asset, target) === 'needed'
    },
  )

  await describeFigureCandidates({candidates: neededCandidates, concurrency, cwd, target})

  const counts = await getFigureDescriptionCountsForArticle({articleId, target})

  return {
    articleId,
    described: counts.described,
    failed: counts.failed,
    missing: neededCandidates.length,
    pending: counts.needed,
    total: counts.total,
  }
}

export const resetFigureDescriptions = async (articleId: string): Promise<{articleId: string; figures: number}> => {
  await requireFigureDescriptionTarget()

  return withArticleAssetWriteLock(articleId, () => {
    return getAppDatabaseService().transaction(async (tx) => {
      const [article] = await tx.queryJson<StoredFigureArticle>(getStoredFigureArticleSql(articleId))

      if (!article) {
        throw new HttpError(404, `Article ${articleId} not found`)
      }

      if (article.conversionStatus !== 'success') {
        throw new HttpError(409, `Article ${articleId} has no successful full-text conversion`)
      }

      const assets = getStoredFigureAssets(article.assets)
      const sourceUpdatedAt = new Date()

      await tx.run(`
        UPDATE app.article
        SET full_text_assets = ${getJsonSqlLiteral(assets.map(getAssetWithoutFigureDescription))},
            updated_at = ${getTimestampLiteral(sourceUpdatedAt)}
        WHERE id = '${escapeSqlString(articleId)}'
      `)
      await appendArticleReviewServingDeltas(tx, {
        articleId,
        changedFields: ['fullText'],
        sourceMutationKey: `figureDescriptions.reset|article|${articleId}|${sourceUpdatedAt.toISOString()}`,
        sourceOperation: 'update',
        sourceUpdatedAt,
      })

      return {articleId, figures: assets.length}
    })
  })
}
