import type {HumanJudgmentMode} from '../../../db/schemaTypes.ts'
import {getDateValue, getQuotedStringList, getSqlLiteral} from '../../services/appQueryHelpers.ts'

export type ComparisonProjectConflictResolutionImportSource = {
  id: string
  name: string
  description: string | null
  createdAt: Date
  humanJudgmentMode: HumanJudgmentMode
  resolutionCount: number
}

export type ComparisonProjectConflictResolutionImportSourceQueryRow = {
  id: string
  name: string
  description: string | null
  createdAt: unknown
  humanJudgmentMode: HumanJudgmentMode | null
  resolutionCount: unknown
}

export type ComparisonProjectConflictResolutionImportMatchKind = 'doi' | 'id-title'

export type ComparisonProjectConflictResolutionImportSourceRow = {
  doi?: string | null
  doiKeys?: readonly (string | null | undefined)[] | null
  externalArticleId?: string | null
  resolutionValue: string
  sourceArticleId: string
  sourceArticleTitle?: string | null
  sourceComparisonProjectId: string
  sourceComparisonProjectName: string
  sourceExternalArticleId?: string | null
  sourceResolutionId: string
  sourceRowId: string
  title?: string | null
}

export type ComparisonProjectConflictResolutionImportTargetArticle = {
  articleId: string
  doi?: string | null
  doiKeys?: readonly (string | null | undefined)[] | null
  externalArticleId?: string | null
  isConflictResolutionEligible: boolean
  title?: string | null
}

export type ComparisonProjectConflictResolutionImportTargetArticleQueryRow = Omit<
  ComparisonProjectConflictResolutionImportTargetArticle,
  'isConflictResolutionEligible'
>

export type ComparisonProjectConflictResolutionImportCandidateSource = {
  matchKey: string
  matchKind: ComparisonProjectConflictResolutionImportMatchKind
  sourceRowId: string
}

export type ComparisonProjectConflictResolutionImportCandidate = {
  resolutionValue: string
  sourceRows: ComparisonProjectConflictResolutionImportCandidateSource[]
  targetArticleId: string
}

export type ComparisonProjectConflictResolutionImportSkipReason =
  | 'ambiguous-target-match'
  | 'no-usable-key'
  | 'no-target-match'
  | 'not-conflicting'

export type ComparisonProjectConflictResolutionImportSkippedRow = {
  reason: ComparisonProjectConflictResolutionImportSkipReason
  sourceRowId: string
}

export type ComparisonProjectConflictResolutionImportSkipCounts = {
  ambiguousTargetMatch: number
  noTargetMatch: number
  noUsableKey: number
  notConflicting: number
}

export type ComparisonProjectConflictResolutionImportErrorCode =
  | 'duplicate-source-doi-key'
  | 'duplicate-source-id-title-key'
  | 'conflicting-source-resolution-values'
  | 'invalid-source-resolution-value'

export type ComparisonProjectConflictResolutionImportError = {
  code: ComparisonProjectConflictResolutionImportErrorCode
  key?: string
  message: string
  sourceRowIds?: string[]
  targetArticleId?: string
  targetArticleIds?: string[]
  value?: string
  values?: string[]
}

export type ComparisonProjectConflictResolutionImportWarningCode = 'ambiguous-target-match'

export type ComparisonProjectConflictResolutionImportWarningSourceRow = {
  articleId: string
  articleTitle: string | null
  compareProjectId: string
  compareProjectName: string
  externalArticleId: string | null
  resolutionAnswer: string
  sourceResolutionId: string
  sourceRowId: string
}

export type ComparisonProjectConflictResolutionImportWarningTargetArticle = {
  articleId: string
  articleTitle: string | null
  doiKeys: string[]
  externalArticleId: string | null
}

export type ComparisonProjectConflictResolutionImportWarning = {
  code: ComparisonProjectConflictResolutionImportWarningCode
  matchKey: string
  matchKind: ComparisonProjectConflictResolutionImportMatchKind
  message: string
  sourceRows: ComparisonProjectConflictResolutionImportWarningSourceRow[]
  targetArticles: ComparisonProjectConflictResolutionImportWarningTargetArticle[]
}

export type ComparisonProjectConflictResolutionImportPlan = {
  candidates: ComparisonProjectConflictResolutionImportCandidate[]
  errors: ComparisonProjectConflictResolutionImportError[]
  skipCounts: ComparisonProjectConflictResolutionImportSkipCounts
  skippedRows: ComparisonProjectConflictResolutionImportSkippedRow[]
  warnings: ComparisonProjectConflictResolutionImportWarning[]
}

export type ComparisonProjectConflictResolutionImportPlanParams = {
  sourceRows: readonly ComparisonProjectConflictResolutionImportSourceRow[]
  targetArticles: readonly ComparisonProjectConflictResolutionImportTargetArticle[]
  targetSummaryOptionValues: readonly string[]
}

export type ComparisonProjectConflictResolutionImportSummary = {
  scanned: number
  matched: number
  imported: number
  skipped: number
}

type NormalizedSourceRow = Omit<ComparisonProjectConflictResolutionImportSourceRow, 'doiKeys'> & {
  doiKeys: string[]
  idTitleKey: string | null
  resolutionValue: string
}

type NormalizedTargetArticle = ComparisonProjectConflictResolutionImportTargetArticle & {
  doiKeys: string[]
  idTitleKey: string | null
}

type ImportCandidateRow = {
  matchKey: string
  matchKind: ComparisonProjectConflictResolutionImportMatchKind
  resolutionValue: string
  sourceRowId: string
  targetArticleId: string
}

type ImportTargetArticleMatch = {matchKey: string; targetArticle: NormalizedTargetArticle}

type ImportCandidateRowResult = {
  candidate: ImportCandidateRow | null
  skippedRow: ComparisonProjectConflictResolutionImportSkippedRow | null
  warnings: ComparisonProjectConflictResolutionImportWarning[]
}

type DuplicateKeyErrorParams = {
  code: ComparisonProjectConflictResolutionImportErrorCode
  entityLabel: string
  idKey: 'sourceRowIds' | 'targetArticleIds'
  keyLabel: string
}

const doiPrefixPattern = /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i
const idTitleKeySeparator = '\u001F'

const getInClause = (values: string[]) => {
  return getQuotedStringList(values).join(', ')
}

const getWhereClause = (conditions: Array<string | null | undefined>) => {
  const filteredConditions = conditions.filter((condition): condition is string => {
    return Boolean(condition)
  })
  return filteredConditions.length > 0 ? `WHERE ${filteredConditions.join('\n  AND ')}` : ''
}

const getComparisonProjectConflictResolutionImportTitleKeySql = (column: string) => {
  return `regexp_replace(LOWER(TRIM(COALESCE(${column}, ''))), '\\s+', ' ', 'g')`
}

const getComparisonProjectConflictResolutionImportIdTitleKeySql = (params: {
  externalArticleIdColumn: string
  titleColumn: string
}) => {
  return `LOWER(TRIM(COALESCE(${params.externalArticleIdColumn}, ''))) || ${getSqlLiteral(idTitleKeySeparator)} || ${getComparisonProjectConflictResolutionImportTitleKeySql(params.titleColumn)}`
}

export const getComparisonProjectConflictResolutionImportSourcesSql = (params: {
  comparisonProjectConflictResolutionTable: string
  comparisonProjectTable: string
}) => {
  return `
    SELECT
      cp.id AS id,
      cp.name AS name,
      cp.description AS description,
      cp.created_at AS createdAt,
      cp.human_judgment_mode AS humanJudgmentMode,
      COUNT(cr.article_id) AS resolutionCount
    FROM ${params.comparisonProjectTable} cp
    INNER JOIN ${params.comparisonProjectConflictResolutionTable} cr
      ON cr.comparison_project_id = cp.id
    WHERE cp.archived = FALSE
      AND cp.allow_conflict_resolution = TRUE
      AND cp.human_judgment_mode = 'summary'
    GROUP BY
      cp.id,
      cp.name,
      cp.description,
      cp.created_at,
      cp.human_judgment_mode
    ORDER BY cp.created_at DESC, cp.name ASC, cp.id ASC
  `
}

export const getComparisonProjectConflictResolutionImportSourceRowsSql = (params: {
  articleIdentifierTable: string
  articleTable: string
  comparisonProjectTable: string
  comparisonProjectConflictResolutionTable: string
  sourceComparisonProjectIds: string[]
}) => {
  return `
    WITH source_resolution AS (
      SELECT
        cr.comparison_project_id AS sourceComparisonProjectId,
        cr.id AS sourceResolutionId,
        cr.id AS sourceRowId,
        cr.article_id AS sourceArticleId,
        COALESCE(cr.answer_value, cr.prompt_id, '') AS resolutionValue
      FROM ${params.comparisonProjectConflictResolutionTable} cr
      ${params.sourceComparisonProjectIds.length > 0 ? `WHERE cr.comparison_project_id IN (${getInClause(params.sourceComparisonProjectIds)})` : 'WHERE FALSE'}
    ),
    doi_identifier AS (
      SELECT
        article_id AS articleId,
        LIST(DISTINCT normalized_value ORDER BY normalized_value) AS doiKeys
      FROM ${params.articleIdentifierTable}
      WHERE kind = 'doi'
      GROUP BY article_id
    )
    SELECT
      source_resolution.sourceComparisonProjectId AS sourceComparisonProjectId,
      source_comparison_project.name AS sourceComparisonProjectName,
      source_resolution.sourceResolutionId AS sourceResolutionId,
      source_resolution.sourceRowId AS sourceRowId,
      source_resolution.sourceArticleId AS sourceArticleId,
      source_article.article_id AS sourceExternalArticleId,
      source_article.article_title AS sourceArticleTitle,
      source_resolution.resolutionValue AS resolutionValue,
      doi_identifier.doiKeys AS doiKeys,
      source_article.article_id AS externalArticleId,
      source_article.article_title AS title
    FROM source_resolution
    INNER JOIN ${params.comparisonProjectTable} source_comparison_project
      ON source_comparison_project.id = source_resolution.sourceComparisonProjectId
    INNER JOIN ${params.articleTable} source_article ON source_article.id = source_resolution.sourceArticleId
    LEFT JOIN doi_identifier ON doi_identifier.articleId = source_article.id
    ORDER BY source_resolution.sourceRowId ASC
  `
}

export const getComparisonProjectConflictResolutionImportDoiTargetArticlesSql = (params: {
  articleIdentifierTable: string
  articleScopeConditions: readonly string[]
  articleTable: string
  doiKeys: string[]
}) => {
  return `
    SELECT
      a.id AS articleId,
      MIN(doi_identifier.normalized_value) AS doi,
      LIST(DISTINCT doi_identifier.normalized_value ORDER BY doi_identifier.normalized_value) AS doiKeys,
      a.article_id AS externalArticleId,
      a.article_title AS title
    FROM ${params.articleIdentifierTable} doi_identifier
    INNER JOIN ${params.articleTable} a ON a.id = doi_identifier.article_id
    ${getWhereClause([
      ...params.articleScopeConditions,
      "doi_identifier.kind = 'doi'",
      params.doiKeys.length > 0 ? `doi_identifier.normalized_value IN (${getInClause(params.doiKeys)})` : 'FALSE',
    ])}
    GROUP BY a.id, a.article_id, a.article_title
    ORDER BY a.id ASC
  `
}

export const getComparisonProjectConflictResolutionImportIdTitleTargetArticlesSql = (params: {
  articleIdentifierTable: string
  articleScopeConditions: readonly string[]
  articleTable: string
  idTitleKeys: string[]
}) => {
  const idTitleKeySql = getComparisonProjectConflictResolutionImportIdTitleKeySql({
    externalArticleIdColumn: 'a.article_id',
    titleColumn: 'a.article_title',
  })

  return `
    WITH doi_identifier AS (
      SELECT
        article_id AS articleId,
        MIN(normalized_value) AS doi
      FROM ${params.articleIdentifierTable}
      WHERE kind = 'doi'
      GROUP BY article_id
    )
    SELECT
      a.id AS articleId,
      doi_identifier.doi AS doi,
      a.article_id AS externalArticleId,
      a.article_title AS title
    FROM ${params.articleTable} a
    LEFT JOIN doi_identifier ON doi_identifier.articleId = a.id
    ${getWhereClause([
      ...params.articleScopeConditions,
      params.idTitleKeys.length > 0 ? `${idTitleKeySql} IN (${getInClause(params.idTitleKeys)})` : 'FALSE',
    ])}
    ORDER BY a.id ASC
  `
}

export const getComparisonProjectConflictResolutionImportSourceValue = (
  row: ComparisonProjectConflictResolutionImportSourceQueryRow,
): ComparisonProjectConflictResolutionImportSource => {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: getDateValue(row.createdAt) ?? new Date(0),
    humanJudgmentMode: row.humanJudgmentMode ?? 'prompt',
    resolutionCount: Number(row.resolutionCount ?? 0),
  }
}

const getTrimmedText = (value: string | null | undefined) => {
  const trimmedValue = value?.trim() ?? ''
  return trimmedValue.length > 0 ? trimmedValue : null
}

const getNormalizedResolutionValue = (value: string) => {
  return value.trim()
}

export const normalizeComparisonProjectConflictResolutionImportDoi = (value: string | null | undefined) => {
  const trimmedValue = getTrimmedText(value)
  const normalizedValue = trimmedValue?.toLowerCase().replace(doiPrefixPattern, '').trim() ?? ''

  return normalizedValue.length > 0 ? normalizedValue : null
}

export const getComparisonProjectConflictResolutionImportDoiKeys = (
  row: Pick<ComparisonProjectConflictResolutionImportSourceRow, 'doi' | 'doiKeys'>,
) => {
  return Array.from(
    new Set(
      [...(row.doiKeys ?? []), row.doi]
        .map((value) => {
          return normalizeComparisonProjectConflictResolutionImportDoi(value)
        })
        .filter((value): value is string => {
          return value !== null
        }),
    ),
  )
}

const mergeComparisonProjectConflictResolutionImportTargetArticleRow = (
  currentRow: ComparisonProjectConflictResolutionImportTargetArticleQueryRow,
  nextRow: ComparisonProjectConflictResolutionImportTargetArticleQueryRow,
): ComparisonProjectConflictResolutionImportTargetArticleQueryRow => {
  return {
    articleId: currentRow.articleId,
    doi: currentRow.doi ?? nextRow.doi ?? null,
    doiKeys: getUniqueStringValues([
      ...getComparisonProjectConflictResolutionImportDoiKeys(currentRow),
      ...getComparisonProjectConflictResolutionImportDoiKeys(nextRow),
    ]),
    externalArticleId: currentRow.externalArticleId ?? nextRow.externalArticleId ?? null,
    title: currentRow.title ?? nextRow.title ?? null,
  }
}

export const mergeComparisonProjectConflictResolutionImportTargetArticleRows = (
  rows: readonly ComparisonProjectConflictResolutionImportTargetArticleQueryRow[],
) => {
  return Array.from(
    rows
      .reduce<Map<string, ComparisonProjectConflictResolutionImportTargetArticleQueryRow>>((rowMap, row) => {
        const currentRow = rowMap.get(row.articleId)

        rowMap.set(
          row.articleId,
          currentRow ? mergeComparisonProjectConflictResolutionImportTargetArticleRow(currentRow, row) : row,
        )
        return rowMap
      }, new Map<string, ComparisonProjectConflictResolutionImportTargetArticleQueryRow>())
      .values(),
  )
}

export const normalizeComparisonProjectConflictResolutionImportExternalArticleId = (
  value: string | null | undefined,
) => {
  const normalizedValue = getTrimmedText(value)?.toLowerCase() ?? ''

  return normalizedValue.length > 0 ? normalizedValue : null
}

export const normalizeComparisonProjectConflictResolutionImportTitle = (value: string | null | undefined) => {
  const normalizedValue = getTrimmedText(value)?.toLowerCase().replace(/\s+/g, ' ') ?? ''

  return normalizedValue.length > 0 ? normalizedValue : null
}

export const getComparisonProjectConflictResolutionImportIdTitleKey = (params: {
  externalArticleId?: string | null
  title?: string | null
}) => {
  const externalArticleId = normalizeComparisonProjectConflictResolutionImportExternalArticleId(
    params.externalArticleId,
  )
  const title = normalizeComparisonProjectConflictResolutionImportTitle(params.title)

  return externalArticleId && title ? `${externalArticleId}${idTitleKeySeparator}${title}` : null
}

const getNormalizedSourceRows = (
  sourceRows: readonly ComparisonProjectConflictResolutionImportSourceRow[],
): NormalizedSourceRow[] => {
  return sourceRows.map((row) => {
    return {
      ...row,
      doiKeys: getComparisonProjectConflictResolutionImportDoiKeys(row),
      idTitleKey: getComparisonProjectConflictResolutionImportIdTitleKey(row),
      resolutionValue: getNormalizedResolutionValue(row.resolutionValue),
    }
  })
}

const getNormalizedTargetArticles = (
  targetArticles: readonly ComparisonProjectConflictResolutionImportTargetArticle[],
): NormalizedTargetArticle[] => {
  return targetArticles.map((article) => {
    const doiKeys = getComparisonProjectConflictResolutionImportDoiKeys(article)

    return {...article, doiKeys, idTitleKey: getComparisonProjectConflictResolutionImportIdTitleKey(article)}
  })
}

const getKeyGroups = <T>(items: readonly T[], getKey: (item: T) => string | null, getId: (item: T) => string) => {
  return items.reduce<Map<string, string[]>>((groupMap, item) => {
    const key = getKey(item)
    const currentIds = key ? (groupMap.get(key) ?? []) : []

    if (key) {
      const itemId = getId(item)
      groupMap.set(key, currentIds.includes(itemId) ? currentIds : [...currentIds, itemId])
    }

    return groupMap
  }, new Map<string, string[]>())
}

const getUniqueStringValues = (values: readonly string[]) => {
  return values.reduce<string[]>((uniqueValues, value) => {
    return uniqueValues.includes(value) ? uniqueValues : [...uniqueValues, value]
  }, [])
}

const getTargetArticleIds = (targetArticles: readonly NormalizedTargetArticle[]) => {
  return getUniqueStringValues(
    targetArticles.map((article) => {
      return article.articleId
    }),
  )
}

const getTargetArticleGroupsByKey = (
  targetArticles: readonly NormalizedTargetArticle[],
  getKey: (article: NormalizedTargetArticle) => string | null,
) => {
  return targetArticles.reduce<Map<string, NormalizedTargetArticle[]>>((articleMap, article) => {
    const key = getKey(article)
    const currentArticles = key ? (articleMap.get(key) ?? []) : []

    return key ? articleMap.set(key, [...currentArticles, article]) : articleMap
  }, new Map<string, NormalizedTargetArticle[]>())
}

const getTargetArticlesByDoiKey = (targetArticles: readonly NormalizedTargetArticle[]) => {
  return targetArticles.reduce<Map<string, NormalizedTargetArticle[]>>((articleMap, article) => {
    return article.doiKeys.reduce<Map<string, NormalizedTargetArticle[]>>((doiMap, doiKey) => {
      const currentArticles = doiMap.get(doiKey) ?? []

      doiMap.set(doiKey, [...currentArticles, article])
      return doiMap
    }, articleMap)
  }, new Map<string, NormalizedTargetArticle[]>())
}

const getTargetArticlesByIdTitleKey = (targetArticles: readonly NormalizedTargetArticle[]) => {
  return getTargetArticleGroupsByKey(targetArticles, (article) => {
    return article.idTitleKey
  })
}

const getDuplicateKeyErrors = (
  keyGroups: Map<string, string[]>,
  params: DuplicateKeyErrorParams,
): ComparisonProjectConflictResolutionImportError[] => {
  return Array.from(keyGroups.entries())
    .filter(([, ids]) => {
      return ids.length > 1
    })
    .map(([key, ids]) => {
      return {
        code: params.code,
        key,
        message: `Duplicate ${params.entityLabel} ${params.keyLabel} import key: ${key}`,
        [params.idKey]: ids,
      }
    })
}

const getSourceDuplicateErrors = (candidateRows: readonly ImportCandidateRow[]) => {
  return [
    ...getDuplicateKeyErrors(
      getKeyGroups(
        candidateRows,
        (row) => {
          return row.matchKind === 'doi' ? row.matchKey : null
        },
        (row) => {
          return row.sourceRowId
        },
      ),
      {code: 'duplicate-source-doi-key', entityLabel: 'source', idKey: 'sourceRowIds', keyLabel: 'DOI'},
    ),
    ...getDuplicateKeyErrors(
      getKeyGroups(
        candidateRows,
        (row) => {
          return row.matchKind === 'id-title' ? row.matchKey : null
        },
        (row) => {
          return row.sourceRowId
        },
      ),
      {
        code: 'duplicate-source-id-title-key',
        entityLabel: 'source',
        idKey: 'sourceRowIds',
        keyLabel: 'external ID/title',
      },
    ),
  ]
}

const getTargetArticlesForSourceDoiKeys = (
  row: NormalizedSourceRow,
  targetArticlesByDoiKey: Map<string, NormalizedTargetArticle[]>,
) => {
  return row.doiKeys.flatMap((doiKey) => {
    return (targetArticlesByDoiKey.get(doiKey) ?? []).map((targetArticle) => {
      return {matchKey: doiKey, targetArticle}
    })
  })
}

const getUniqueTargetArticleMatches = (matches: readonly ImportTargetArticleMatch[]) => {
  return Array.from(
    matches
      .reduce<Map<string, ImportTargetArticleMatch>>((matchMap, match) => {
        return matchMap.has(match.targetArticle.articleId)
          ? matchMap
          : matchMap.set(match.targetArticle.articleId, match)
      }, new Map<string, ImportTargetArticleMatch>())
      .values(),
  )
}

const getCanUseIdTitleFallbackTargetArticle = (row: NormalizedSourceRow, targetArticle: NormalizedTargetArticle) => {
  return row.idTitleKey === targetArticle.idTitleKey && (row.doiKeys.length === 0 || targetArticle.doiKeys.length === 0)
}

const getWarningSourceRow = (row: NormalizedSourceRow): ComparisonProjectConflictResolutionImportWarningSourceRow => {
  return {
    articleId: row.sourceArticleId,
    articleTitle: row.sourceArticleTitle ?? row.title ?? null,
    compareProjectId: row.sourceComparisonProjectId,
    compareProjectName: row.sourceComparisonProjectName,
    externalArticleId: row.sourceExternalArticleId ?? row.externalArticleId ?? null,
    resolutionAnswer: row.resolutionValue,
    sourceResolutionId: row.sourceResolutionId,
    sourceRowId: row.sourceRowId,
  }
}

const getWarningTargetArticle = (
  targetArticle: NormalizedTargetArticle,
): ComparisonProjectConflictResolutionImportWarningTargetArticle => {
  return {
    articleId: targetArticle.articleId,
    articleTitle: targetArticle.title ?? null,
    doiKeys: targetArticle.doiKeys,
    externalArticleId: targetArticle.externalArticleId ?? null,
  }
}

const getAmbiguousTargetMatchWarning = (params: {
  matchKey: string
  matchKind: ComparisonProjectConflictResolutionImportMatchKind
  sourceRow: NormalizedSourceRow
  targetArticles: readonly NormalizedTargetArticle[]
}): ComparisonProjectConflictResolutionImportWarning => {
  const targetArticleIds = getTargetArticleIds(params.targetArticles)

  return {
    code: 'ambiguous-target-match',
    matchKey: params.matchKey,
    matchKind: params.matchKind,
    message: `Source row ${params.sourceRow.sourceRowId} matched multiple eligible target articles: ${targetArticleIds.join(', ')}`,
    sourceRows: [getWarningSourceRow(params.sourceRow)],
    targetArticles: params.targetArticles.map(getWarningTargetArticle),
  }
}

const getValidResolutionValueSet = (targetSummaryOptionValues: readonly string[]) => {
  return new Set(
    targetSummaryOptionValues.map(getNormalizedResolutionValue).filter((value) => {
      return value.length > 0
    }),
  )
}

const getInvalidResolutionValueErrors = (
  candidateRows: readonly ImportCandidateRow[],
  targetSummaryOptionValues: readonly string[],
) => {
  const validResolutionValues = getValidResolutionValueSet(targetSummaryOptionValues)

  return candidateRows
    .filter((row) => {
      return !validResolutionValues.has(row.resolutionValue)
    })
    .map<ComparisonProjectConflictResolutionImportError>((row) => {
      return {
        code: 'invalid-source-resolution-value',
        message: `Source resolution value is not valid for the target comparison project: ${row.resolutionValue}`,
        sourceRowIds: [row.sourceRowId],
        value: row.resolutionValue,
      }
    })
}

const getSkippedRow = (
  sourceRowId: string,
  reason: ComparisonProjectConflictResolutionImportSkipReason,
): ComparisonProjectConflictResolutionImportSkippedRow => {
  return {reason, sourceRowId}
}

const getTargetArticleMaps = (targetArticles: readonly NormalizedTargetArticle[]) => {
  return {
    byDoiKey: getTargetArticlesByDoiKey(targetArticles),
    byIdTitleKey: getTargetArticlesByIdTitleKey(targetArticles),
  }
}

const getEligibleTargetMatches = (matches: readonly ImportTargetArticleMatch[]) => {
  return matches.filter((match) => {
    return match.targetArticle.isConflictResolutionEligible
  })
}

const getTargetArticlesFromMatches = (matches: readonly ImportTargetArticleMatch[]) => {
  return matches.map((match) => {
    return match.targetArticle
  })
}

const getAmbiguousMatchKey = (matches: readonly ImportTargetArticleMatch[]) => {
  return getUniqueStringValues(
    matches.map((match) => {
      return match.matchKey
    }),
  ).join(', ')
}

const getCandidateRow = (params: {
  matchKey: string
  matchKind: ComparisonProjectConflictResolutionImportMatchKind
  row: NormalizedSourceRow
  targetArticle: NormalizedTargetArticle
}): ImportCandidateRow => {
  return {
    matchKey: params.matchKey,
    matchKind: params.matchKind,
    resolutionValue: params.row.resolutionValue,
    sourceRowId: params.row.sourceRowId,
    targetArticleId: params.targetArticle.articleId,
  }
}

const getDoiTieBreakerMatches = (row: NormalizedSourceRow, matches: readonly ImportTargetArticleMatch[]) => {
  return row.idTitleKey
    ? matches.filter((match) => {
        return match.targetArticle.idTitleKey === row.idTitleKey
      })
    : []
}

const getDoiImportCandidateRow = (
  row: NormalizedSourceRow,
  targetArticleMaps: ReturnType<typeof getTargetArticleMaps>,
): ImportCandidateRowResult | null => {
  const targetMatches = getUniqueTargetArticleMatches(
    getTargetArticlesForSourceDoiKeys(row, targetArticleMaps.byDoiKey),
  )
  const eligibleMatches = getEligibleTargetMatches(targetMatches)
  const tieBreakerMatches = getDoiTieBreakerMatches(row, eligibleMatches)
  const selectedMatch =
    eligibleMatches.length === 1 ? eligibleMatches[0] : tieBreakerMatches.length === 1 ? tieBreakerMatches[0] : null
  const skipReason =
    targetMatches.length === 0
      ? null
      : eligibleMatches.length === 0
        ? 'not-conflicting'
        : selectedMatch
          ? null
          : 'ambiguous-target-match'

  return selectedMatch
    ? {
        candidate: getCandidateRow({
          matchKey: selectedMatch.matchKey,
          matchKind: 'doi',
          row,
          targetArticle: selectedMatch.targetArticle,
        }),
        skippedRow: null,
        warnings: [],
      }
    : skipReason
      ? {
          candidate: null,
          skippedRow: getSkippedRow(row.sourceRowId, skipReason),
          warnings:
            skipReason === 'ambiguous-target-match'
              ? [
                  getAmbiguousTargetMatchWarning({
                    matchKey: getAmbiguousMatchKey(eligibleMatches),
                    matchKind: 'doi',
                    sourceRow: row,
                    targetArticles: getTargetArticlesFromMatches(eligibleMatches),
                  }),
                ]
              : [],
        }
      : null
}

const getIdTitleImportCandidateRow = (
  row: NormalizedSourceRow,
  targetArticleMaps: ReturnType<typeof getTargetArticleMaps>,
): ImportCandidateRowResult => {
  const targetMatches = getUniqueTargetArticleMatches(
    row.idTitleKey
      ? (targetArticleMaps.byIdTitleKey.get(row.idTitleKey) ?? [])
          .filter((targetArticle) => {
            return getCanUseIdTitleFallbackTargetArticle(row, targetArticle)
          })
          .map((targetArticle) => {
            return {matchKey: row.idTitleKey ?? '', targetArticle}
          })
      : [],
  )
  const eligibleMatches = getEligibleTargetMatches(targetMatches)
  const selectedMatch = eligibleMatches.length === 1 ? eligibleMatches[0] : null
  const skipReason =
    targetMatches.length === 0
      ? 'no-target-match'
      : eligibleMatches.length === 0
        ? 'not-conflicting'
        : selectedMatch
          ? null
          : 'ambiguous-target-match'

  return selectedMatch
    ? {
        candidate: getCandidateRow({
          matchKey: selectedMatch.matchKey,
          matchKind: 'id-title',
          row,
          targetArticle: selectedMatch.targetArticle,
        }),
        skippedRow: null,
        warnings: [],
      }
    : {
        candidate: null,
        skippedRow: getSkippedRow(row.sourceRowId, skipReason),
        warnings:
          skipReason === 'ambiguous-target-match'
            ? [
                getAmbiguousTargetMatchWarning({
                  matchKey: getAmbiguousMatchKey(eligibleMatches),
                  matchKind: 'id-title',
                  sourceRow: row,
                  targetArticles: getTargetArticlesFromMatches(eligibleMatches),
                }),
              ]
            : [],
      }
}

const getImportCandidateRow = (
  row: NormalizedSourceRow,
  targetArticleMaps: ReturnType<typeof getTargetArticleMaps>,
): ImportCandidateRowResult => {
  const hasUsableKey = row.doiKeys.length > 0 || Boolean(row.idTitleKey)
  const doiResult = hasUsableKey && row.doiKeys.length > 0 ? getDoiImportCandidateRow(row, targetArticleMaps) : null

  return !hasUsableKey
    ? {candidate: null, skippedRow: getSkippedRow(row.sourceRowId, 'no-usable-key'), warnings: []}
    : doiResult
      ? doiResult
      : getIdTitleImportCandidateRow(row, targetArticleMaps)
}

const getCandidateRows = (
  sourceRows: readonly NormalizedSourceRow[],
  targetArticles: readonly NormalizedTargetArticle[],
) => {
  const targetArticleMaps = getTargetArticleMaps(targetArticles)

  return sourceRows.map((row) => {
    return getImportCandidateRow(row, targetArticleMaps)
  })
}

const getSkipCounts = (
  skippedRows: readonly ComparisonProjectConflictResolutionImportSkippedRow[],
): ComparisonProjectConflictResolutionImportSkipCounts => {
  return skippedRows.reduce<ComparisonProjectConflictResolutionImportSkipCounts>(
    (counts, skippedRow) => {
      return {
        ambiguousTargetMatch: counts.ambiguousTargetMatch + (skippedRow.reason === 'ambiguous-target-match' ? 1 : 0),
        noTargetMatch: counts.noTargetMatch + (skippedRow.reason === 'no-target-match' ? 1 : 0),
        noUsableKey: counts.noUsableKey + (skippedRow.reason === 'no-usable-key' ? 1 : 0),
        notConflicting: counts.notConflicting + (skippedRow.reason === 'not-conflicting' ? 1 : 0),
      }
    },
    {ambiguousTargetMatch: 0, noTargetMatch: 0, noUsableKey: 0, notConflicting: 0},
  )
}

const getConflictingResolutionValueErrors = (candidateRows: readonly ImportCandidateRow[]) => {
  const candidateRowsByTargetArticleId = candidateRows.reduce<Map<string, ImportCandidateRow[]>>(
    (candidateMap, row) => {
      const currentRows = candidateMap.get(row.targetArticleId) ?? []

      candidateMap.set(row.targetArticleId, [...currentRows, row])
      return candidateMap
    },
    new Map<string, ImportCandidateRow[]>(),
  )

  return Array.from(candidateRowsByTargetArticleId.entries())
    .map<ComparisonProjectConflictResolutionImportError | null>(([targetArticleId, rows]) => {
      const values = Array.from(
        new Set(
          rows.map((row) => {
            return row.resolutionValue
          }),
        ),
      )
      const sourceRowIds = rows.map((row) => {
        return row.sourceRowId
      })

      return values.length > 1
        ? {
            code: 'conflicting-source-resolution-values',
            message: `Conflicting source resolution values map to target article ${targetArticleId}: ${values.join(', ')}`,
            sourceRowIds,
            targetArticleId,
            values,
          }
        : null
    })
    .filter((error): error is ComparisonProjectConflictResolutionImportError => {
      return error !== null
    })
}

const getImportCandidates = (candidateRows: readonly ImportCandidateRow[]) => {
  return Array.from(
    candidateRows
      .reduce<Map<string, ComparisonProjectConflictResolutionImportCandidate>>((candidateMap, row) => {
        const existingCandidate = candidateMap.get(row.targetArticleId)
        const sourceRow = {matchKey: row.matchKey, matchKind: row.matchKind, sourceRowId: row.sourceRowId}

        candidateMap.set(
          row.targetArticleId,
          existingCandidate
            ? {...existingCandidate, sourceRows: [...existingCandidate.sourceRows, sourceRow]}
            : {resolutionValue: row.resolutionValue, sourceRows: [sourceRow], targetArticleId: row.targetArticleId},
        )
        return candidateMap
      }, new Map<string, ComparisonProjectConflictResolutionImportCandidate>())
      .values(),
  )
}

export const getComparisonProjectConflictResolutionImportPlan = ({
  sourceRows,
  targetArticles,
  targetSummaryOptionValues,
}: ComparisonProjectConflictResolutionImportPlanParams): ComparisonProjectConflictResolutionImportPlan => {
  const normalizedSourceRows = getNormalizedSourceRows(sourceRows)
  const normalizedTargetArticles = getNormalizedTargetArticles(targetArticles)
  const candidateRowResults = getCandidateRows(normalizedSourceRows, normalizedTargetArticles)
  const candidateRows = candidateRowResults
    .map((result) => {
      return result.candidate
    })
    .filter((candidate): candidate is ImportCandidateRow => {
      return candidate !== null
    })
  const skippedRows = candidateRowResults
    .map((result) => {
      return result.skippedRow
    })
    .filter((skippedRow): skippedRow is ComparisonProjectConflictResolutionImportSkippedRow => {
      return skippedRow !== null
    })
  const warnings = candidateRowResults.flatMap((result) => {
    return result.warnings
  })
  const duplicateErrors = getSourceDuplicateErrors(candidateRows)
  const invalidValueErrors = getInvalidResolutionValueErrors(candidateRows, targetSummaryOptionValues)
  const conflictErrors = getConflictingResolutionValueErrors(candidateRows)
  const errors = [...duplicateErrors, ...invalidValueErrors, ...conflictErrors]

  return {
    candidates: errors.length > 0 ? [] : getImportCandidates(candidateRows),
    errors,
    skipCounts: getSkipCounts(skippedRows),
    skippedRows,
    warnings,
  }
}
