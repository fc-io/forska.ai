import {defaultSystemPromptVariant} from '../../../agent/judge/systemPromptVariant.ts'
import {FULL_TEXT_STRATEGY_NONE, getFullTextStrategyDisplayLabel} from '../../fullText/fullTextStrategy.ts'
import {
  compareComparisonProjectContentDimensions,
  defaultComparisonProjectContentDimension,
  getComparisonProjectContentLabel,
  getUniqueComparisonProjectContentDimensions,
} from './comparisonProjectContentDimensions.ts'
import {getComparisonProjectContentKey} from './comparisonProjectJudgmentRows/getComparisonProjectContentKey.ts'
import type {
  ComparisonProjectContentDimension,
  ComparisonProjectContentFlags,
  ComparisonProjectContentVariant,
  ComparisonProjectFullTextStrategyLabels,
} from './comparisonProjectScopeTypes.ts'
import {isDefined} from './comparisonProjectValueHelpers.ts'

const getComparisonProjectContentFlagVariants = (
  settings: ComparisonProjectContentFlags,
): ComparisonProjectContentFlags[] => {
  return [
    settings.useTitle || settings.useAbstract
      ? {useTitle: settings.useTitle, useAbstract: settings.useAbstract, useFulltext: false, useFulltextNoImages: false}
      : null,
    settings.useFulltext ? {useTitle: false, useAbstract: false, useFulltext: true, useFulltextNoImages: false} : null,
    settings.useFulltextNoImages
      ? {useTitle: false, useAbstract: false, useFulltext: false, useFulltextNoImages: true}
      : null,
  ].filter(isDefined)
}

const getComparisonProjectFullTextStrategyLabel = (
  fullTextStrategyLabels: ComparisonProjectFullTextStrategyLabels,
  fullTextStrategyId: string,
) => {
  return fullTextStrategyLabels.get(fullTextStrategyId) ?? getFullTextStrategyDisplayLabel(fullTextStrategyId, null)
}

const getComparisonProjectContentVariantLabel = (
  contentFlags: ComparisonProjectContentFlags,
  contentDimension: ComparisonProjectContentDimension,
  showSystemPromptVariant: boolean,
  fullTextStrategyLabels: ComparisonProjectFullTextStrategyLabels,
) => {
  const contentLabel = getComparisonProjectContentLabel({...contentFlags, useMetadata: contentDimension.useMetadata})
  const variantContentLabel = showSystemPromptVariant
    ? `${contentLabel} · System prompt variant: ${contentDimension.systemPromptVariant}`
    : contentLabel

  return contentDimension.fullTextStrategyId === FULL_TEXT_STRATEGY_NONE
    ? variantContentLabel
    : `${variantContentLabel} · Full text: ${getComparisonProjectFullTextStrategyLabel(fullTextStrategyLabels, contentDimension.fullTextStrategyId)}`
}

const getIsFullTextContentFlags = (contentFlags: ComparisonProjectContentFlags) => {
  return contentFlags.useFulltext || contentFlags.useFulltextNoImages
}

const getHasSameBaseContentDimension = (
  left: ComparisonProjectContentDimension,
  right: ComparisonProjectContentDimension,
) => {
  return left.systemPromptVariant === right.systemPromptVariant && left.useMetadata === right.useMetadata
}

const getComparisonProjectBaseContentDimensions = (contentDimensions: readonly ComparisonProjectContentDimension[]) => {
  return getUniqueComparisonProjectContentDimensions(
    contentDimensions.map((contentDimension) => {
      return {...contentDimension, fullTextStrategyId: FULL_TEXT_STRATEGY_NONE}
    }),
  )
}

const getComparisonProjectFullTextContentDimensions = (
  contentDimensions: readonly ComparisonProjectContentDimension[],
) => {
  return getComparisonProjectBaseContentDimensions(contentDimensions).flatMap((baseContentDimension) => {
    const fullTextContentDimensions = contentDimensions.filter((contentDimension) => {
      return (
        contentDimension.fullTextStrategyId !== FULL_TEXT_STRATEGY_NONE
        && getHasSameBaseContentDimension(contentDimension, baseContentDimension)
      )
    })

    return fullTextContentDimensions.length > 0 ? fullTextContentDimensions : [baseContentDimension]
  })
}

const getComparisonProjectContentDimensionsForFlags = (
  contentFlags: ComparisonProjectContentFlags,
  contentDimensions: readonly ComparisonProjectContentDimension[],
) => {
  return getIsFullTextContentFlags(contentFlags)
    ? getComparisonProjectFullTextContentDimensions(contentDimensions)
    : getComparisonProjectBaseContentDimensions(contentDimensions)
}

export const getComparisonProjectContentVariants = (
  settings: ComparisonProjectContentFlags,
  contentDimensions: readonly ComparisonProjectContentDimension[] = [defaultComparisonProjectContentDimension],
  fullTextStrategyLabels: ComparisonProjectFullTextStrategyLabels = new Map<string, string>(),
): ComparisonProjectContentVariant[] => {
  const contentFlagVariants = getComparisonProjectContentFlagVariants(settings)
  const showSystemPromptVariant = contentDimensions.some((contentDimension) => {
    return contentDimension.systemPromptVariant !== defaultSystemPromptVariant
  })

  return contentFlagVariants
    .flatMap((contentFlags, flagOrder) => {
      return getComparisonProjectContentDimensionsForFlags(contentFlags, contentDimensions).map((contentDimension) => {
        return {contentDimension, contentFlags, flagOrder}
      })
    })
    .sort((left, right) => {
      const dimensionDiff = compareComparisonProjectContentDimensions(left.contentDimension, right.contentDimension)

      return dimensionDiff !== 0 ? dimensionDiff : left.flagOrder - right.flagOrder
    })
    .map<ComparisonProjectContentVariant>(({contentDimension, contentFlags}) => {
      return {
        ...contentFlags,
        ...contentDimension,
        key: getComparisonProjectContentKey({...contentFlags, ...contentDimension}),
        label: getComparisonProjectContentVariantLabel(
          contentFlags,
          contentDimension,
          showSystemPromptVariant,
          fullTextStrategyLabels,
        ),
      }
    })
}
