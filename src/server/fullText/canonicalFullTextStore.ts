import {readFile} from 'node:fs/promises'

import {getJsonSqlLiteral} from '../providers/providerDbUtils.ts'
import {
  appendArticleReviewServingDeltas,
  getArticleReviewServingMutationValueHash,
} from '../reviewServing/articleReviewServingDeltaService.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {escapeSqlString, getJsonValue, getSqlLiteral, getTimestampLiteral} from '../services/appQueryHelpers.ts'
import {HttpError} from '../utils/httpError.ts'
import {resolveRuntimeFilePath} from '../utils/runtimeWritablePath.ts'
import {
  buildCanonicalFullText,
  buildCanonicalFullTextFromConversion,
  type CanonicalFullText,
  type CanonicalFullTextAsset,
  type CanonicalFullTextStats,
  type FullTextFigureMode,
} from './canonicalFullText.ts'
import {type FullTextConversionRuntimeConfig, getFullTextConversionMetadata} from './converters/fullTextConverter.ts'
import {
  FULL_TEXT_LAYOUT_VERSION,
  type FullTextConversionResult,
  type FullTextConverterKind,
  type FullTextLayoutBlock,
} from './converters/fullTextConverterTypes.ts'

type DuckdbWorkloadContext = Parameters<ReturnType<typeof getAppDatabaseService>['transaction']>[1]

type StoredCanonicalArticle = {
  fullTextAssets: string | null
  fullTextCanonicalHash: string | null
  fullTextCanonicalVersion: string | null
  fullTextConversionMetadata: string | null
  fullTextConversionStatus: string | null
  fullTextFigureModeBuilt: string | null
}

export const canonicalFullTextStoredForm = 'markers'

export const markerFormFigureModesBuilt = [canonicalFullTextStoredForm, 'native_images'] as const

export type CanonicalFullTextRebuildResult = {
  articleId: string
  changed: boolean
  form: typeof canonicalFullTextStoredForm
  hash: string
  stats: CanonicalFullTextStats
  version: string
}

const storedFormFigureMode: FullTextFigureMode = 'native_images'

export const isMarkerFormFigureModeBuilt = (value: string | null | undefined): boolean => {
  return (markerFormFigureModesBuilt as readonly string[]).includes(value ?? '')
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const getCanonicalFullTextSetSql = (canonical: CanonicalFullText): string => {
  return [
    `full_text = ${getSqlLiteral(canonical.text)}`,
    `full_text_canonical_hash = ${getSqlLiteral(canonical.hash)}`,
    `full_text_canonical_version = ${getSqlLiteral(canonical.version)}`,
    `full_text_figure_mode_built = ${getSqlLiteral(canonicalFullTextStoredForm)}`,
    `full_text_char_count = ${canonical.text.length}`,
  ].join(',\n')
}

export const storeConvertedFullText = async ({
  articleId,
  attempts,
  mutationSource,
  result,
  runtimeConfig,
  workloadContext,
}: {
  articleId: string
  attempts: number
  mutationSource: string
  result: FullTextConversionResult
  runtimeConfig: FullTextConversionRuntimeConfig
  workloadContext?: DuckdbWorkloadContext
}): Promise<CanonicalFullText> => {
  const canonical = buildCanonicalFullTextFromConversion({figureMode: storedFormFigureMode, result})
  const sourceUpdatedAt = new Date()
  const valueHash = getArticleReviewServingMutationValueHash({html: result.html, md: canonical.text})

  await getAppDatabaseService().transaction(async (tx) => {
    await tx.run(`
      UPDATE app.article
      SET ${getCanonicalFullTextSetSql(canonical)},
          full_text_html = ${getSqlLiteral(result.html)},
          full_text_assets = ${getJsonSqlLiteral(result.figures)},
          full_text_conversion_status = 'success',
          full_text_conversion_error = NULL,
          full_text_conversion_model_id = ${getSqlLiteral(runtimeConfig.modelId)},
          full_text_conversion_metadata = ${getJsonSqlLiteral(getFullTextConversionMetadata({result, runtimeConfig}))},
          full_text_conversion_attempts = ${attempts},
          updated_at = ${getTimestampLiteral(sourceUpdatedAt)}
      WHERE id = '${escapeSqlString(articleId)}'
    `)
    await appendArticleReviewServingDeltas(tx, {
      articleId,
      changedFields: ['fullText', 'fullTextHtml'],
      sourceMutationKey: `${mutationSource}|article|${articleId}|success|${sourceUpdatedAt.toISOString()}|${valueHash}`,
      sourceOperation: 'update',
      sourceUpdatedAt,
    })
  }, workloadContext)

  return canonical
}

const getStoredCanonicalArticle = async (articleId: string): Promise<StoredCanonicalArticle> => {
  const [article] = await getAppDatabaseService().queryJson<StoredCanonicalArticle>(`
    SELECT
      CAST(full_text_assets AS VARCHAR) AS fullTextAssets,
      full_text_canonical_hash AS fullTextCanonicalHash,
      full_text_canonical_version AS fullTextCanonicalVersion,
      CAST(full_text_conversion_metadata AS VARCHAR) AS fullTextConversionMetadata,
      full_text_conversion_status AS fullTextConversionStatus,
      full_text_figure_mode_built AS fullTextFigureModeBuilt
    FROM app.article
    WHERE id = '${escapeSqlString(articleId)}'
    LIMIT 1
  `)

  if (!article) {
    throw new HttpError(404, `Article ${articleId} not found`)
  }

  if (article.fullTextConversionStatus !== 'success') {
    throw new HttpError(409, `Article ${articleId} has no successful full-text conversion`)
  }

  return article
}

const getStoredConversionInputs = (
  articleId: string,
  metadataText: string | null,
): {converterKind: FullTextConverterKind; layoutPath: string} => {
  const metadata = getJsonValue(metadataText)
  const converterKind = isRecord(metadata) ? metadata.converterKind : null
  const layoutPath = isRecord(metadata) ? metadata.layoutPath : null

  if ((converterKind !== 'mineru' && converterKind !== 'docling') || typeof layoutPath !== 'string') {
    throw new HttpError(
      409,
      `Article ${articleId} conversion metadata has no converterKind/layoutPath; reconvert the article`,
    )
  }

  return {converterKind, layoutPath}
}

const readStoredLayout = async ({
  articleId,
  cwd,
  layoutPath,
}: {
  articleId: string
  cwd?: string
  layoutPath: string
}): Promise<FullTextLayoutBlock[]> => {
  const absolutePath = resolveRuntimeFilePath({cwd, pathValue: layoutPath})
  const content = await readFile(absolutePath, 'utf8').catch(() => {
    throw new HttpError(409, `Article ${articleId} layout file ${layoutPath} is missing; reconvert the article`)
  })
  const layoutFile = getJsonValue(content)

  if (!isRecord(layoutFile) || layoutFile.version !== FULL_TEXT_LAYOUT_VERSION || !Array.isArray(layoutFile.blocks)) {
    throw new HttpError(
      409,
      `Article ${articleId} layout file ${layoutPath} is not ${FULL_TEXT_LAYOUT_VERSION}; reconvert the article`,
    )
  }

  return layoutFile.blocks as FullTextLayoutBlock[]
}

const isCanonicalAsset = (value: unknown): value is CanonicalFullTextAsset => {
  return (
    isRecord(value)
    && Number.isInteger(value.index)
    && (value.caption === null || typeof value.caption === 'string')
    && (value.description === undefined || value.description === null || typeof value.description === 'string')
  )
}

const getStoredAssets = (articleId: string, assetsText: string | null): CanonicalFullTextAsset[] => {
  const assets = assetsText === null ? [] : getJsonValue(assetsText)

  if (!Array.isArray(assets) || !assets.every(isCanonicalAsset)) {
    throw new HttpError(409, `Article ${articleId} full_text_assets is not a figure list; reconvert the article`)
  }

  return assets
}

const isStoredCanonicalCurrent = (article: StoredCanonicalArticle, canonical: CanonicalFullText): boolean => {
  return (
    article.fullTextCanonicalHash === canonical.hash
    && article.fullTextCanonicalVersion === canonical.version
    && isMarkerFormFigureModeBuilt(article.fullTextFigureModeBuilt)
  )
}

const writeRebuiltCanonicalFullText = async (articleId: string, canonical: CanonicalFullText): Promise<void> => {
  const sourceUpdatedAt = new Date()

  await getAppDatabaseService().transaction(async (tx) => {
    await tx.run(`
      UPDATE app.article
      SET ${getCanonicalFullTextSetSql(canonical)},
          updated_at = ${getTimestampLiteral(sourceUpdatedAt)}
      WHERE id = '${escapeSqlString(articleId)}'
    `)
    await appendArticleReviewServingDeltas(tx, {
      articleId,
      changedFields: ['fullText'],
      sourceMutationKey: `canonicalFullText.rebuild|article|${articleId}|${canonicalFullTextStoredForm}|${sourceUpdatedAt.toISOString()}|${canonical.hash}`,
      sourceOperation: 'update',
      sourceUpdatedAt,
    })
  })
}

export const rebuildCanonicalFullText = async ({
  articleId,
  cwd,
}: {
  articleId: string
  cwd?: string
}): Promise<CanonicalFullTextRebuildResult> => {
  const article = await getStoredCanonicalArticle(articleId)
  const {converterKind, layoutPath} = getStoredConversionInputs(articleId, article.fullTextConversionMetadata)
  const layout = await readStoredLayout({articleId, cwd, layoutPath})
  const canonical = buildCanonicalFullText({
    assets: getStoredAssets(articleId, article.fullTextAssets),
    converterKind,
    figureMode: storedFormFigureMode,
    layout,
  })
  const changed = !isStoredCanonicalCurrent(article, canonical)

  if (changed) {
    await writeRebuiltCanonicalFullText(articleId, canonical)
  }

  return {
    articleId,
    changed,
    form: canonicalFullTextStoredForm,
    hash: canonical.hash,
    stats: canonical.stats,
    version: canonical.version,
  }
}
