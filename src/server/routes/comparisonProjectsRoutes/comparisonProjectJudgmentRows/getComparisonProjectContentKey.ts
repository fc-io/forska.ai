import {defaultSystemPromptVariant, getSystemPromptVariant} from '../../../../agent/judge/systemPromptVariant.ts'
import {isReservedFullTextStrategyId} from '../../../fullText/fullTextStrategy.ts'

const comparisonProjectContentKeySystemPromptVariantSeparator = '-'
const comparisonProjectContentKeyMetadataSuffix = 'm'
export const comparisonProjectContentKeyFullTextStrategySeparator = '~'

const getComparisonProjectContentKeyFullTextStrategySuffix = (fullTextStrategyId: string | null | undefined) => {
  return isReservedFullTextStrategyId(fullTextStrategyId)
    ? ''
    : `${comparisonProjectContentKeyFullTextStrategySeparator}${fullTextStrategyId}`
}

export const getComparisonProjectContentKey = (settings: {
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useMetadata?: boolean | null
  systemPromptVariant?: string | null
  fullTextStrategyId?: string | null
}) => {
  const flagKey = [settings.useTitle, settings.useAbstract, settings.useFulltext, settings.useFulltextNoImages]
    .map((value) => {
      return (value ? 1 : 0).toString()
    })
    .join('')
  const contentKey = settings.useMetadata ? `${flagKey}${comparisonProjectContentKeyMetadataSuffix}` : flagKey
  const systemPromptVariant = getSystemPromptVariant(settings.systemPromptVariant)
  const variantContentKey =
    systemPromptVariant === defaultSystemPromptVariant
      ? contentKey
      : `${contentKey}${comparisonProjectContentKeySystemPromptVariantSeparator}${systemPromptVariant}`

  return `${variantContentKey}${getComparisonProjectContentKeyFullTextStrategySuffix(settings.fullTextStrategyId)}`
}
