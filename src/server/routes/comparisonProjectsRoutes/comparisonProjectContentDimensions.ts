import {
  defaultSystemPromptVariant,
  getSystemPromptVariant,
  systemPromptVariants,
} from '../../../agent/judge/systemPromptVariant.ts'
import {legacyFullTextNoImagesLabel} from '../../../utils/legacyFullTextNoImagesLabel.ts'
import {
  FULL_TEXT_STRATEGY_LEGACY,
  FULL_TEXT_STRATEGY_NONE,
  getEffectiveFullTextStrategyId,
} from '../../fullText/fullTextStrategy.ts'
import {getFullTextStrategyLabelsById} from '../../fullText/fullTextStrategyRepository.ts'
import type {AppQueryRunner} from './comparisonProjectRouteTypes.ts'
import type {
  ComparisonProjectContentDimension,
  ComparisonProjectContentFlags,
  ComparisonProjectFullTextStrategyLabels,
} from './comparisonProjectScopeTypes.ts'

const comparisonProjectContentMetadataLabel = 'Metadata'

export const getComparisonProjectContentLabel = (settings: ComparisonProjectContentFlags & {useMetadata?: boolean}) => {
  const textLabel =
    settings.useTitle || settings.useAbstract
      ? settings.useTitle && settings.useAbstract
        ? 'Article Title and Abstract'
        : settings.useTitle
          ? 'Article Title'
          : 'Article Abstract'
      : null
  const fulltextLabel = settings.useFulltextNoImages
    ? legacyFullTextNoImagesLabel
    : settings.useFulltext
      ? 'Use Full Text'
      : null
  const parts = [textLabel, fulltextLabel].filter(Boolean) as string[]
  const contentLabel = parts.length > 0 ? parts.join(' + ') : 'No content selected'

  return settings.useMetadata ? `${contentLabel} · ${comparisonProjectContentMetadataLabel}` : contentLabel
}

export type ComparisonProjectContentDimensionRow = {
  fullTextStrategyId?: string | null
  systemPromptVariant?: string | null
  useMetadata?: boolean | null
}

export const defaultComparisonProjectContentDimension: ComparisonProjectContentDimension = {
  fullTextStrategyId: FULL_TEXT_STRATEGY_NONE,
  systemPromptVariant: defaultSystemPromptVariant,
  useMetadata: false,
}

const reservedFullTextStrategyOrders: Record<string, number> = {
  [FULL_TEXT_STRATEGY_LEGACY]: 1,
  [FULL_TEXT_STRATEGY_NONE]: 0,
}

const getComparisonProjectContentDimensionKey = (contentDimension: ComparisonProjectContentDimension) => {
  return `${contentDimension.systemPromptVariant}:${contentDimension.useMetadata}:${contentDimension.fullTextStrategyId}`
}

const getComparisonProjectContentDimensionOrder = (contentDimension: ComparisonProjectContentDimension) => {
  return (
    systemPromptVariants.indexOf(contentDimension.systemPromptVariant)
    + (contentDimension.useMetadata ? systemPromptVariants.length + 1 : 0)
  )
}

const getFullTextStrategyOrder = (fullTextStrategyId: string) => {
  return reservedFullTextStrategyOrders[fullTextStrategyId] ?? Object.keys(reservedFullTextStrategyOrders).length
}

const compareFullTextStrategyIds = (left: string, right: string) => {
  const orderDiff = getFullTextStrategyOrder(left) - getFullTextStrategyOrder(right)

  return orderDiff !== 0 ? orderDiff : left.localeCompare(right)
}

export const compareComparisonProjectContentDimensions = (
  left: ComparisonProjectContentDimension,
  right: ComparisonProjectContentDimension,
) => {
  const fullTextStrategyDiff = compareFullTextStrategyIds(left.fullTextStrategyId, right.fullTextStrategyId)

  return fullTextStrategyDiff !== 0
    ? fullTextStrategyDiff
    : getComparisonProjectContentDimensionOrder(left) - getComparisonProjectContentDimensionOrder(right)
}

const getNormalizedComparisonProjectContentDimension = (
  contentDimension: ComparisonProjectContentDimensionRow,
): ComparisonProjectContentDimension => {
  return {
    fullTextStrategyId: getEffectiveFullTextStrategyId(contentDimension.fullTextStrategyId),
    systemPromptVariant: getSystemPromptVariant(contentDimension.systemPromptVariant),
    useMetadata: contentDimension.useMetadata === true,
  }
}

export const getUniqueComparisonProjectContentDimensions = (
  contentDimensions: readonly ComparisonProjectContentDimension[],
) => {
  return Array.from(
    contentDimensions
      .reduce<Map<string, ComparisonProjectContentDimension>>((dimensionMap, contentDimension) => {
        return dimensionMap.set(getComparisonProjectContentDimensionKey(contentDimension), contentDimension)
      }, new Map<string, ComparisonProjectContentDimension>())
      .values(),
  ).sort(compareComparisonProjectContentDimensions)
}

export const getComparisonProjectContentDimensions = (
  contentDimensions: ReadonlyArray<ComparisonProjectContentDimensionRow>,
): ComparisonProjectContentDimension[] => {
  const uniqueContentDimensions = getUniqueComparisonProjectContentDimensions(
    contentDimensions.map(getNormalizedComparisonProjectContentDimension),
  )

  return uniqueContentDimensions.length > 0 ? uniqueContentDimensions : [defaultComparisonProjectContentDimension]
}

export const getComparisonProjectFullTextStrategyLabels = async (
  queryRunner: AppQueryRunner,
  contentDimensions: readonly ComparisonProjectContentDimension[],
): Promise<ComparisonProjectFullTextStrategyLabels> => {
  return getFullTextStrategyLabelsById(
    queryRunner,
    contentDimensions
      .map((contentDimension) => {
        return contentDimension.fullTextStrategyId
      })
      .filter((fullTextStrategyId) => {
        return !(fullTextStrategyId in reservedFullTextStrategyOrders)
      }),
  )
}
