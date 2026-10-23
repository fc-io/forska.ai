import {getQuotedStringList, getSqlLiteral} from '../../services/appQueryHelpers.ts'
import type {ComparisonProjectContentVariant} from './comparisonProjectScopeTypes.ts'

export const getBooleanLiteral = (value: boolean) => {
  return value ? 'TRUE' : 'FALSE'
}

export const getInClause = (values: string[]) => {
  return getQuotedStringList(values).join(', ')
}

export const getWhereClause = (conditions: Array<string | null | undefined>) => {
  const filteredConditions = conditions.filter((condition): condition is string => {
    return Boolean(condition)
  })
  return filteredConditions.length > 0 ? `WHERE ${filteredConditions.join('\n  AND ')}` : ''
}

const getContentVariantClause = (tableAlias: string, contentVariant: ComparisonProjectContentVariant) => {
  return `(
    ${tableAlias}.use_title = ${getBooleanLiteral(contentVariant.useTitle)}
    AND ${tableAlias}.use_abstract = ${getBooleanLiteral(contentVariant.useAbstract)}
    AND ${tableAlias}.use_fulltext = ${getBooleanLiteral(contentVariant.useFulltext)}
    AND ${tableAlias}.use_fulltext_no_images = ${getBooleanLiteral(contentVariant.useFulltextNoImages)}
    AND ${tableAlias}.use_metadata = ${getBooleanLiteral(contentVariant.useMetadata)}
    AND ${tableAlias}.system_prompt_variant = ${getSqlLiteral(contentVariant.systemPromptVariant)}
    AND ${tableAlias}.full_text_strategy_id = ${getSqlLiteral(contentVariant.fullTextStrategyId)}
  )`
}

export const getComparisonProjectContentClause = (
  tableAlias: string,
  contentVariants: ComparisonProjectContentVariant[],
) => {
  return contentVariants.length === 0
    ? null
    : `(${contentVariants
        .map((contentVariant) => {
          return getContentVariantClause(tableAlias, contentVariant)
        })
        .join(' OR ')})`
}
