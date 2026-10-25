import {
  type ComparisonProjectCovidenceExportSelection,
  getComparisonProjectCovidenceExportSelectedRows,
  getHasComparisonProjectCovidenceExportSelection,
} from '../../../../utils/comparisonProjectCovidenceExportSelection.ts'
import {forEachComparisonProjectServingJudgmentRowBatch} from '../comparisonProjectJudgmentRows.ts'
import type {ComparisonProjectJudgmentRow} from '../comparisonProjectJudgmentRows/comparisonProjectJudgmentRowsTypes.ts'
import {comparisonProjectJudgmentArticleBatchSize} from '../comparisonProjectRouteConstants.ts'
import {appDatabaseService} from '../comparisonProjectRouteServices.ts'
import type {ComparisonProjectScope} from '../comparisonProjectScopeTypes.ts'
import type {ComparisonProjectExportRow} from '../comparisonProjectsRoutesPostExport/comparisonProjectExportRow.ts'
import {getComparisonProjectRowsWithConflictResolutions} from '../getComparisonProjectRowsWithConflictResolutions.ts'

type ForEachComparisonProjectCovidenceExportRowBatchParams = {
  onRows: (rows: ComparisonProjectExportRow[]) => Promise<void> | void
  scope: ComparisonProjectScope
  selection: ComparisonProjectCovidenceExportSelection
}

const getCanReadComparisonProjectCovidenceExportRows = (
  scope: ComparisonProjectScope,
  selection: ComparisonProjectCovidenceExportSelection,
) => {
  return (
    !scope.archived
    && scope.activeGeneration !== null
    && scope.prompts.length > 0
    && scope.columns.length > 0
    && getHasComparisonProjectCovidenceExportSelection(selection)
  )
}

const getComparisonProjectCovidenceExportCandidateRows = async (
  scope: ComparisonProjectScope,
  selection: ComparisonProjectCovidenceExportSelection,
  rows: ComparisonProjectJudgmentRow[],
): Promise<ComparisonProjectExportRow[]> => {
  return selection.conflictResolutionValues.length > 0
    ? getComparisonProjectRowsWithConflictResolutions(scope, rows)
    : rows
}

const addComparisonProjectCovidenceExportedArticleIds = (
  exportedArticleIds: Set<string>,
  rows: readonly ComparisonProjectExportRow[],
) => {
  return rows.reduce((articleIds, row) => {
    return articleIds.add(row.canonicalArticleId)
  }, exportedArticleIds)
}

export const forEachComparisonProjectCovidenceExportRowBatch = async (
  params: ForEachComparisonProjectCovidenceExportRowBatchParams,
) => {
  const exportedArticleIds = new Set<string>()

  return getCanReadComparisonProjectCovidenceExportRows(params.scope, params.selection)
    ? forEachComparisonProjectServingJudgmentRowBatch({
        comparisonProjectId: params.scope.id,
        currentJudgmentContextId: params.scope.judgmentContextId,
        differenceFilter: [],
        limit: comparisonProjectJudgmentArticleBatchSize,
        onRows: async (rows) => {
          const candidateRows = await getComparisonProjectCovidenceExportCandidateRows(
            params.scope,
            params.selection,
            rows,
          )
          const selectedRows = getComparisonProjectCovidenceExportSelectedRows(
            candidateRows,
            params.selection,
            exportedArticleIds,
          )

          addComparisonProjectCovidenceExportedArticleIds(exportedArticleIds, selectedRows)
          await (selectedRows.length > 0 ? params.onRows(selectedRows) : undefined)
        },
        queryRunner: appDatabaseService,
        rowFilter: [],
      })
    : undefined
}
