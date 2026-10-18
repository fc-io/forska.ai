import {
  buildCanonicalFullText,
  CANONICAL_TEXT_VERSION,
  type CanonicalFullTextAsset,
} from '../../fullText/canonicalFullText.ts'
import {FULL_TEXT_LAYOUT_VERSION, type FullTextLayoutBlock} from '../../fullText/converters/fullTextConverterTypes.ts'
import type {ProjectTransferPlanBlocker} from './projectTransferContracts.ts'
import type {ProjectTransferArticlePayloadRecord} from './projectTransferPayloadSchemas.ts'

type JsonRecord = Record<string, unknown>

type CanonicalRebuildInput = {
  article: ProjectTransferArticlePayloadRecord
  hash: string
  readPackageFile: (packagePath: string) => Promise<string>
}

const canonicalStoredFormFigureMode = 'native_images'
const markerFormFigureModesBuilt = ['markers', 'native_images']

const isRecord = (value: unknown): value is JsonRecord => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const getRebuildBlocker = ({
  code,
  message,
  sourceArticleId,
}: {
  code: string
  message: string
  sourceArticleId: string
}): ProjectTransferPlanBlocker[] => {
  return [
    {
      code,
      message,
      resolutionKind: 'requires_new_package_or_target_changes',
      scope: `articles.${sourceArticleId}.fullTextCanonicalHash`,
    },
  ]
}

const getParsedJson = (content: string): unknown => {
  try {
    return JSON.parse(content) as unknown
  } catch {
    return null
  }
}

const getLayoutBlocks = (content: string | null): FullTextLayoutBlock[] | null => {
  const layoutFile = content === null ? null : getParsedJson(content)

  return isRecord(layoutFile) && layoutFile.version === FULL_TEXT_LAYOUT_VERSION && Array.isArray(layoutFile.blocks)
    ? (layoutFile.blocks as FullTextLayoutBlock[])
    : null
}

const getRebuiltHash = ({
  article,
  converterKind,
  layout,
}: {
  article: ProjectTransferArticlePayloadRecord
  converterKind: 'docling' | 'mineru'
  layout: FullTextLayoutBlock[]
}) => {
  try {
    return {
      hash: buildCanonicalFullText({
        assets: (Array.isArray(article.fullTextAssets) ? article.fullTextAssets : []) as CanonicalFullTextAsset[],
        converterKind,
        figureMode: canonicalStoredFormFigureMode,
        layout,
      }).hash,
      ok: true as const,
    }
  } catch (error) {
    return {message: error instanceof Error ? error.message : String(error), ok: false as const}
  }
}

const getCanonicalRebuildBlockers = async ({article, hash, readPackageFile}: CanonicalRebuildInput) => {
  const sourceArticleId = article.sourceArticleId
  const metadata = isRecord(article.fullTextConversionMetadata) ? article.fullTextConversionMetadata : {}
  const converterKind = metadata.converterKind
  const layoutPath = typeof metadata.layoutPath === 'string' ? metadata.layoutPath : ''

  if (converterKind !== 'mineru' && converterKind !== 'docling') {
    return getRebuildBlocker({
      code: 'article_full_text_canonical_rebuild_failed',
      message: `${sourceArticleId} conversion metadata has no supported converterKind to rebuild its canonical full text`,
      sourceArticleId,
    })
  }

  const layout = getLayoutBlocks(
    await readPackageFile(layoutPath).catch(() => {
      return null
    }),
  )

  if (layout === null) {
    return getRebuildBlocker({
      code: 'article_full_text_canonical_rebuild_failed',
      message: `${sourceArticleId} package layout ${layoutPath} is missing or is not ${FULL_TEXT_LAYOUT_VERSION}`,
      sourceArticleId,
    })
  }

  const rebuilt = getRebuiltHash({article, converterKind, layout})

  return !rebuilt.ok
    ? getRebuildBlocker({
        code: 'article_full_text_canonical_rebuild_failed',
        message: `${sourceArticleId} canonical full text cannot be rebuilt from ${layoutPath}: ${rebuilt.message}`,
        sourceArticleId,
      })
    : rebuilt.hash === hash
      ? []
      : getRebuildBlocker({
          code: 'article_full_text_canonical_rebuild_mismatch',
          message: `${sourceArticleId} canonical full text ${hash} rebuilds from ${layoutPath} as ${rebuilt.hash}`,
          sourceArticleId,
        })
}

export const getProjectTransferCanonicalFullTextRebuildBlockers = async ({
  articles,
  readPackageFile,
}: {
  articles: readonly ProjectTransferArticlePayloadRecord[]
  readPackageFile: (packagePath: string) => Promise<string>
}): Promise<ProjectTransferPlanBlocker[]> => {
  const blockerGroups = await articles.reduce<Promise<ProjectTransferPlanBlocker[][]>>(async (previous, article) => {
    const groups = await previous
    const hash = article.fullTextCanonicalHash
    const builtByThisVersion =
      article.fullTextCanonicalVersion === CANONICAL_TEXT_VERSION
      && markerFormFigureModesBuilt.includes(String(article.fullTextFigureModeBuilt))

    if (typeof hash === 'string' && builtByThisVersion) {
      groups.push(await getCanonicalRebuildBlockers({article, hash, readPackageFile}))
    }

    return groups
  }, Promise.resolve([]))

  return blockerGroups.flat()
}
