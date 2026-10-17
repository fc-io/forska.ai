import {
  FULL_TEXT_STRATEGY_LEGACY,
  FULL_TEXT_STRATEGY_NONE,
  type FullTextStrategyInputs,
  getFullTextStrategyInputDifferences,
} from './fullTextStrategyOptions.ts'

export type ComparisonProjectFullTextStrategySource = {
  fullTextStrategyId: string
  fullTextStrategyInputs: FullTextStrategyInputs | null
  fullTextStrategyLabel: string
  name: string
}

const reservedFullTextStrategyIds = new Set([FULL_TEXT_STRATEGY_LEGACY, FULL_TEXT_STRATEGY_NONE])

const fullTextInputDifferenceLabel = 'full text'

const getUniqueValues = (values: readonly string[]) => {
  return Array.from(new Set(values))
}

const getDistinctStrategySources = (sources: readonly ComparisonProjectFullTextStrategySource[]) => {
  return Array.from(
    sources
      .reduce<Map<string, ComparisonProjectFullTextStrategySource>>((sourceMap, source) => {
        return sourceMap.has(source.fullTextStrategyId) ? sourceMap : sourceMap.set(source.fullTextStrategyId, source)
      }, new Map<string, ComparisonProjectFullTextStrategySource>())
      .values(),
  )
}

const getComparableInputs = (source: ComparisonProjectFullTextStrategySource) => {
  return reservedFullTextStrategyIds.has(source.fullTextStrategyId) ? null : source.fullTextStrategyInputs
}

const getStrategyPairInputDifferences = (
  left: ComparisonProjectFullTextStrategySource,
  right: ComparisonProjectFullTextStrategySource,
): string[] => {
  const leftInputs = getComparableInputs(left)
  const rightInputs = getComparableInputs(right)

  return leftInputs && rightInputs
    ? getFullTextStrategyInputDifferences(leftInputs, rightInputs)
    : [fullTextInputDifferenceLabel]
}

export const getComparisonProjectFullTextStrategyInputDifferences = (
  sources: readonly ComparisonProjectFullTextStrategySource[],
) => {
  const [firstSource, ...otherSources] = getDistinctStrategySources(sources)

  return firstSource
    ? getUniqueValues(
        otherSources.flatMap((otherSource) => {
          return getStrategyPairInputDifferences(firstSource, otherSource)
        }),
      )
    : []
}

const getSourceStrategyLine = (source: ComparisonProjectFullTextStrategySource) => {
  return `${source.name}: ${source.fullTextStrategyLabel}`
}

const getComparisonProjectFullTextStrategyMixMessage = (
  sources: readonly ComparisonProjectFullTextStrategySource[],
) => {
  const projectLines = sources.map(getSourceStrategyLine).join('; ')
  const differingInputs = getComparisonProjectFullTextStrategyInputDifferences(sources).join(', ')

  return `Selected projects use different full-text strategies: ${projectLines}. Differing inputs: ${differingInputs}`
}

export const getComparisonProjectFullTextStrategyMixError = (
  sources: readonly ComparisonProjectFullTextStrategySource[],
) => {
  return getDistinctStrategySources(sources).length > 1 ? getComparisonProjectFullTextStrategyMixMessage(sources) : null
}
