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
  sourceRowId: string
  title?: string | null
}

export type ComparisonProjectConflictResolutionImportTargetArticle = {
  articleId: string
  doi?: string | null
  externalArticleId?: string | null
  isConflictResolutionEligible: boolean
  title?: string | null
}

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
  | 'no-usable-key'
  | 'no-target-match'
  | 'not-conflicting'

export type ComparisonProjectConflictResolutionImportSkippedRow = {
  reason: ComparisonProjectConflictResolutionImportSkipReason
  sourceRowId: string
}

export type ComparisonProjectConflictResolutionImportSkipCounts = {
  noTargetMatch: number
  noUsableKey: number
  notConflicting: number
}

export type ComparisonProjectConflictResolutionImportErrorCode =
  | 'duplicate-source-doi-key'
  | 'duplicate-target-doi-key'
  | 'duplicate-source-id-title-key'
  | 'duplicate-target-id-title-key'
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

export type ComparisonProjectConflictResolutionImportPlan = {
  candidates: ComparisonProjectConflictResolutionImportCandidate[]
  errors: ComparisonProjectConflictResolutionImportError[]
  skipCounts: ComparisonProjectConflictResolutionImportSkipCounts
  skippedRows: ComparisonProjectConflictResolutionImportSkippedRow[]
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
  doiKey: string | null
  idTitleKey: string | null
}

type ImportCandidateRow = {
  matchKey: string
  matchKind: ComparisonProjectConflictResolutionImportMatchKind
  resolutionValue: string
  sourceRowId: string
  targetArticleId: string
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
  comparisonProjectConflictResolutionTable: string
  sourceComparisonProjectIds: string[]
}) => {
  return `
    WITH source_resolution AS (
      SELECT
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
      source_resolution.sourceRowId AS sourceRowId,
      source_resolution.resolutionValue AS resolutionValue,
      doi_identifier.doiKeys AS doiKeys,
      article.article_id AS externalArticleId,
      article.article_title AS title
    FROM source_resolution
    INNER JOIN ${params.articleTable} article ON article.id = source_resolution.sourceArticleId
    LEFT JOIN doi_identifier ON doi_identifier.articleId = article.id
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
      doi_identifier.normalized_value AS doi,
      NULL AS externalArticleId,
      NULL AS title
    FROM ${params.articleIdentifierTable} doi_identifier
    INNER JOIN ${params.articleTable} a ON a.id = doi_identifier.article_id
    ${getWhereClause([
      ...params.articleScopeConditions,
      "doi_identifier.kind = 'doi'",
      params.doiKeys.length > 0 ? `doi_identifier.normalized_value IN (${getInClause(params.doiKeys)})` : 'FALSE',
    ])}
    GROUP BY a.id, doi_identifier.normalized_value
    ORDER BY a.id ASC, doi_identifier.normalized_value ASC
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
    return {
      ...article,
      doiKey: normalizeComparisonProjectConflictResolutionImportDoi(article.doi),
      idTitleKey: getComparisonProjectConflictResolutionImportIdTitleKey(article),
    }
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

const getCandidateMatchKeys = (
  candidateRows: readonly ImportCandidateRow[],
  matchKind: ComparisonProjectConflictResolutionImportMatchKind,
) => {
  return new Set(
    candidateRows
      .filter((row) => {
        return row.matchKind === matchKind
      })
      .map((row) => {
        return row.matchKey
      }),
  )
}

const getTargetDuplicateErrors = (
  targetArticles: readonly NormalizedTargetArticle[],
  candidateRows: readonly ImportCandidateRow[],
) => {
  const idTitleCandidateKeys = getCandidateMatchKeys(candidateRows, 'id-title')

  return [
    ...getDuplicateKeyErrors(
      getKeyGroups(
        targetArticles,
        (article) => {
          return article.doiKey
        },
        (article) => {
          return article.articleId
        },
      ),
      {code: 'duplicate-target-doi-key', entityLabel: 'target', idKey: 'targetArticleIds', keyLabel: 'DOI'},
    ),
    ...getDuplicateKeyErrors(
      getKeyGroups(
        targetArticles,
        (article) => {
          return article.idTitleKey && idTitleCandidateKeys.has(article.idTitleKey) ? article.idTitleKey : null
        },
        (article) => {
          return article.articleId
        },
      ),
      {
        code: 'duplicate-target-id-title-key',
        entityLabel: 'target',
        idKey: 'targetArticleIds',
        keyLabel: 'external ID/title',
      },
    ),
  ]
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

const getTargetArticleMaps = (targetArticles: readonly NormalizedTargetArticle[]) => {
  return {
    byDoiKey: targetArticles.reduce<Map<string, NormalizedTargetArticle>>((articleMap, article) => {
      return article.doiKey && !articleMap.has(article.doiKey) ? articleMap.set(article.doiKey, article) : articleMap
    }, new Map<string, NormalizedTargetArticle>()),
    byIdTitleKey: targetArticles.reduce<Map<string, NormalizedTargetArticle>>((articleMap, article) => {
      return article.idTitleKey && !articleMap.has(article.idTitleKey)
        ? articleMap.set(article.idTitleKey, article)
        : articleMap
    }, new Map<string, NormalizedTargetArticle>()),
  }
}

const getDoiMatchedTargetArticle = (
  row: NormalizedSourceRow,
  targetArticleMaps: ReturnType<typeof getTargetArticleMaps>,
) => {
  return row.doiKeys
    .map((doiKey) => {
      return {doiKey, targetArticle: targetArticleMaps.byDoiKey.get(doiKey) ?? null}
    })
    .find((match): match is {doiKey: string; targetArticle: NormalizedTargetArticle} => {
      return match.targetArticle !== null
    })
}

const getMatchedTargetArticle = (
  row: NormalizedSourceRow,
  targetArticleMaps: ReturnType<typeof getTargetArticleMaps>,
): {
  matchKey: string
  matchKind: ComparisonProjectConflictResolutionImportMatchKind
  targetArticle: NormalizedTargetArticle
} | null => {
  const doiMatch = getDoiMatchedTargetArticle(row, targetArticleMaps)
  const idTitleTargetArticle = row.idTitleKey ? targetArticleMaps.byIdTitleKey.get(row.idTitleKey) : null
  const canUseIdTitleTargetArticle = Boolean(
    idTitleTargetArticle && (row.doiKeys.length === 0 || !idTitleTargetArticle.doiKey),
  )

  return doiMatch
    ? {matchKey: doiMatch.doiKey, matchKind: 'doi', targetArticle: doiMatch.targetArticle}
    : canUseIdTitleTargetArticle && idTitleTargetArticle && row.idTitleKey
      ? {matchKey: row.idTitleKey, matchKind: 'id-title', targetArticle: idTitleTargetArticle}
      : null
}

const getSkippedRow = (
  sourceRowId: string,
  reason: ComparisonProjectConflictResolutionImportSkipReason,
): ComparisonProjectConflictResolutionImportSkippedRow => {
  return {reason, sourceRowId}
}

const getImportCandidateRow = (
  row: NormalizedSourceRow,
  targetArticleMaps: ReturnType<typeof getTargetArticleMaps>,
): {candidate: ImportCandidateRow | null; skippedRow: ComparisonProjectConflictResolutionImportSkippedRow | null} => {
  const hasUsableKey = row.doiKeys.length > 0 || Boolean(row.idTitleKey)
  const matchedTarget = hasUsableKey ? getMatchedTargetArticle(row, targetArticleMaps) : null
  const skipReason = !hasUsableKey
    ? 'no-usable-key'
    : !matchedTarget
      ? 'no-target-match'
      : !matchedTarget.targetArticle.isConflictResolutionEligible
        ? 'not-conflicting'
        : null

  return skipReason
    ? {candidate: null, skippedRow: getSkippedRow(row.sourceRowId, skipReason)}
    : matchedTarget
      ? {
          candidate: {
            matchKey: matchedTarget.matchKey,
            matchKind: matchedTarget.matchKind,
            resolutionValue: row.resolutionValue,
            sourceRowId: row.sourceRowId,
            targetArticleId: matchedTarget.targetArticle.articleId,
          },
          skippedRow: null,
        }
      : {candidate: null, skippedRow: null}
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
        noTargetMatch: counts.noTargetMatch + (skippedRow.reason === 'no-target-match' ? 1 : 0),
        noUsableKey: counts.noUsableKey + (skippedRow.reason === 'no-usable-key' ? 1 : 0),
        notConflicting: counts.notConflicting + (skippedRow.reason === 'not-conflicting' ? 1 : 0),
      }
    },
    {noTargetMatch: 0, noUsableKey: 0, notConflicting: 0},
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
  const duplicateErrors = [
    ...getSourceDuplicateErrors(candidateRows),
    ...getTargetDuplicateErrors(normalizedTargetArticles, candidateRows),
  ]
  const invalidValueErrors = getInvalidResolutionValueErrors(candidateRows, targetSummaryOptionValues)
  const conflictErrors = getConflictingResolutionValueErrors(candidateRows)
  const errors = [...duplicateErrors, ...invalidValueErrors, ...conflictErrors]

  return {
    candidates: errors.length > 0 ? [] : getImportCandidates(candidateRows),
    errors,
    skipCounts: getSkipCounts(skippedRows),
    skippedRows,
  }
}
