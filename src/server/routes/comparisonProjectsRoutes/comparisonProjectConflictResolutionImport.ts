export type ComparisonProjectConflictResolutionImportMatchKind = 'doi' | 'id-title'

export type ComparisonProjectConflictResolutionImportSourceRow = {
  doi?: string | null
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

type NormalizedSourceRow = ComparisonProjectConflictResolutionImportSourceRow & {
  doiKey: string | null
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

const getComparisonProjectConflictResolutionImportIdTitleKey = (params: {
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
      doiKey: normalizeComparisonProjectConflictResolutionImportDoi(row.doi),
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
      groupMap.set(key, [...currentIds, getId(item)])
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

const getSourceDuplicateErrors = (sourceRows: readonly NormalizedSourceRow[]) => {
  return [
    ...getDuplicateKeyErrors(
      getKeyGroups(
        sourceRows,
        (row) => {
          return row.doiKey
        },
        (row) => {
          return row.sourceRowId
        },
      ),
      {code: 'duplicate-source-doi-key', entityLabel: 'source', idKey: 'sourceRowIds', keyLabel: 'DOI'},
    ),
    ...getDuplicateKeyErrors(
      getKeyGroups(
        sourceRows,
        (row) => {
          return row.idTitleKey
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

const getTargetDuplicateErrors = (targetArticles: readonly NormalizedTargetArticle[]) => {
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
          return article.idTitleKey
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
  sourceRows: readonly NormalizedSourceRow[],
  targetSummaryOptionValues: readonly string[],
) => {
  const validResolutionValues = getValidResolutionValueSet(targetSummaryOptionValues)

  return sourceRows
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

const getMatchedTargetArticle = (
  row: NormalizedSourceRow,
  targetArticleMaps: ReturnType<typeof getTargetArticleMaps>,
): {
  matchKey: string
  matchKind: ComparisonProjectConflictResolutionImportMatchKind
  targetArticle: NormalizedTargetArticle
} | null => {
  const doiTargetArticle = row.doiKey ? targetArticleMaps.byDoiKey.get(row.doiKey) : null
  const idTitleTargetArticle = row.idTitleKey ? targetArticleMaps.byIdTitleKey.get(row.idTitleKey) : null
  const canUseIdTitleTargetArticle = Boolean(idTitleTargetArticle && (!row.doiKey || !idTitleTargetArticle.doiKey))

  return doiTargetArticle && row.doiKey
    ? {matchKey: row.doiKey, matchKind: 'doi', targetArticle: doiTargetArticle}
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
  const hasUsableKey = Boolean(row.doiKey || row.idTitleKey)
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
  const duplicateErrors = [
    ...getSourceDuplicateErrors(normalizedSourceRows),
    ...getTargetDuplicateErrors(normalizedTargetArticles),
  ]
  const invalidValueErrors = getInvalidResolutionValueErrors(normalizedSourceRows, targetSummaryOptionValues)
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
  const conflictErrors = getConflictingResolutionValueErrors(candidateRows)
  const errors = [...duplicateErrors, ...invalidValueErrors, ...conflictErrors]

  return {
    candidates: errors.length > 0 ? [] : getImportCandidates(candidateRows),
    errors,
    skipCounts: getSkipCounts(skippedRows),
    skippedRows,
  }
}
