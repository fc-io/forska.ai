import type {
  ImportCandidateRow,
  NormalizedTargetArticle,
} from './comparisonProjectConflictResolutionImportMatchTypes.ts'
import type {
  ComparisonProjectConflictResolutionImportCandidate,
  ComparisonProjectConflictResolutionImportMatchKind,
  ComparisonProjectConflictResolutionImportSkippedRow,
  ComparisonProjectConflictResolutionImportWarning,
} from './comparisonProjectConflictResolutionImportTypes.ts'
import {getUniqueStringValues} from './comparisonProjectConflictResolutionImportUtils.ts'
import {getWarningSourceRow, getWarningTargetArticle} from './getImportWarningRows.ts'
import {getSkippedRow} from './getSkippedRow.ts'
import {getTargetArticleIds} from './getTargetArticleIds.ts'

const getCandidateRowsByTargetArticleId = (candidateRows: readonly ImportCandidateRow[]) => {
  return candidateRows.reduce<Map<string, ImportCandidateRow[]>>((candidateMap, row) => {
    const currentRows = candidateMap.get(row.targetArticleId) ?? []

    candidateMap.set(row.targetArticleId, [...currentRows, row])
    return candidateMap
  }, new Map<string, ImportCandidateRow[]>())
}

const getCandidateRowResolutionValues = (candidateRows: readonly ImportCandidateRow[]) => {
  return getUniqueStringValues(
    candidateRows.flatMap((row) => {
      return row.resolutionValue === null ? [] : [row.resolutionValue]
    }),
  )
}

const getCandidateRowsWithResolutionsFirst = (candidateRows: readonly ImportCandidateRow[]) => {
  return [
    ...candidateRows.filter((row) => {
      return row.resolutionValue !== null
    }),
    ...candidateRows.filter((row) => {
      return row.resolutionValue === null
    }),
  ]
}

const getCandidateRowMatchKinds = (candidateRows: readonly ImportCandidateRow[]) => {
  return candidateRows.reduce<ComparisonProjectConflictResolutionImportMatchKind[]>((matchKinds, row) => {
    return matchKinds.includes(row.matchKind) ? matchKinds : [...matchKinds, row.matchKind]
  }, [])
}

const getWarningTargetArticles = (candidateRows: readonly ImportCandidateRow[]) => {
  return Array.from(
    candidateRows
      .reduce<Map<string, NormalizedTargetArticle>>((targetArticleMap, row) => {
        return targetArticleMap.has(row.targetArticleId)
          ? targetArticleMap
          : targetArticleMap.set(row.targetArticleId, row.targetArticle)
      }, new Map<string, NormalizedTargetArticle>())
      .values(),
  ).map(getWarningTargetArticle)
}

const getConflictingResolutionValuesWarning = (
  candidateRows: readonly ImportCandidateRow[],
): ComparisonProjectConflictResolutionImportWarning => {
  const values = getCandidateRowResolutionValues(candidateRows)
  const matchKeys = getUniqueStringValues(
    candidateRows.map((row) => {
      return row.matchKey
    }),
  )
  const matchKinds = getCandidateRowMatchKinds(candidateRows)
  const targetArticleIds = getTargetArticleIds(
    candidateRows.map((row) => {
      return row.targetArticle
    }),
  )

  return {
    code: 'conflicting-resolution-values',
    matchKey: matchKeys.join(', '),
    matchKeys,
    matchKind: matchKinds[0],
    matchKinds,
    message: `Conflicting source resolution values map to target article ${targetArticleIds.join(', ')}: ${values.join(', ')}`,
    sourceRows: candidateRows.map((row) => {
      return getWarningSourceRow(row.sourceRow)
    }),
    targetArticles: getWarningTargetArticles(candidateRows),
    values,
  }
}

const getImportCandidateSourceRows = (candidateRows: readonly ImportCandidateRow[]) => {
  return candidateRows.map((row) => {
    return {matchKey: row.matchKey, matchKind: row.matchKind, sourceRowId: row.sourceRowId}
  })
}

const getImportCandidateFromCandidateRows = (
  candidateRows: readonly ImportCandidateRow[],
): ComparisonProjectConflictResolutionImportCandidate | null => {
  const orderedRows = getCandidateRowsWithResolutionsFirst(candidateRows)
  const firstRow = orderedRows[0]

  return firstRow
    ? {
        resolutionValue: firstRow.resolutionValue,
        sourceRows: getImportCandidateSourceRows(orderedRows),
        targetArticleId: firstRow.targetArticleId,
      }
    : null
}

export const getGroupedImportCandidates = (candidateRows: readonly ImportCandidateRow[]) => {
  return Array.from(getCandidateRowsByTargetArticleId(candidateRows).values()).reduce<{
    candidates: ComparisonProjectConflictResolutionImportCandidate[]
    skippedRows: ComparisonProjectConflictResolutionImportSkippedRow[]
    warnings: ComparisonProjectConflictResolutionImportWarning[]
  }>(
    (result, rows) => {
      const values = getCandidateRowResolutionValues(rows)
      const candidate = values.length <= 1 ? getImportCandidateFromCandidateRows(rows) : null

      return candidate
        ? {...result, candidates: [...result.candidates, candidate]}
        : {
            candidates: result.candidates,
            skippedRows: [
              ...result.skippedRows,
              ...rows.map((row) => {
                return getSkippedRow(row.sourceRowId, 'conflicting-resolution-values')
              }),
            ],
            warnings: [...result.warnings, getConflictingResolutionValuesWarning(rows)],
          }
    },
    {candidates: [], skippedRows: [], warnings: []},
  )
}
