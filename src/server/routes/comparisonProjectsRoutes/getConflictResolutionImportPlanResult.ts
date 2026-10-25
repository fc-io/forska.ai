import {comparisonProjectConflictCommentTable} from './comparisonProjectConflictComment.ts'
import {getComparisonProjectConflictResolutionImportPlan} from './comparisonProjectConflictResolutionImport.ts'
import type {
  ComparisonProjectConflictResolutionImportMode,
  ComparisonProjectConflictResolutionImportSourceRow,
} from './comparisonProjectConflictResolutionImport/comparisonProjectConflictResolutionImportTypes.ts'
import {getComparisonProjectConflictResolutionImportSourceRowsSql} from './comparisonProjectConflictResolutionImport/getComparisonProjectConflictResolutionImportSourceRowsSql.ts'
import {
  type ComparisonProjectConflictResolutionImportSourceRowQueryRow,
  getComparisonProjectConflictResolutionImportSourceRowValue,
} from './comparisonProjectConflictResolutionImport/getComparisonProjectConflictResolutionImportSourceRowValue.ts'
import {getConflictResolutionImportRejectedError} from './comparisonProjectConflictResolutionImportValidation.ts'
import {getComparisonProjectPromptTypeOptions} from './comparisonProjectConflictResolutionOptions.ts'
import {
  articleIdentifierTable,
  articleImportRouteTable,
  articleTable,
  comparisonProjectConflictResolutionTable,
  comparisonProjectImportRouteTable,
  comparisonProjectSourceProjectTable,
  comparisonProjectTable,
  projectImportRouteTable,
} from './comparisonProjectRouteConstants.ts'
import type {AppQueryRunner, PromptSelection} from './comparisonProjectRouteTypes.ts'
import type {ComparisonProjectScope} from './comparisonProjectScopeTypes.ts'
import {getUniqueStringValues} from './comparisonProjectValueHelpers.ts'
import {getComparisonProjectPromptConfigsForSelections} from './getComparisonProjectPromptConfigsForSelections.ts'
import {getConflictResolutionImportTargetArticles} from './getConflictResolutionImportTargetArticles.ts'

const getConflictResolutionImportSourceRows = async (
  db: AppQueryRunner,
  sourceComparisonProjectIds: string[],
): Promise<ComparisonProjectConflictResolutionImportSourceRow[]> => {
  const rows = await db.queryJson<ComparisonProjectConflictResolutionImportSourceRowQueryRow>(
    getComparisonProjectConflictResolutionImportSourceRowsSql({
      articleIdentifierTable,
      articleImportRouteTable,
      articleTable,
      comparisonProjectConflictCommentTable,
      comparisonProjectImportRouteTable,
      comparisonProjectSourceProjectTable,
      comparisonProjectTable,
      comparisonProjectConflictResolutionTable,
      projectImportRouteTable,
      sourceComparisonProjectIds,
    }),
  )

  return rows.map(getComparisonProjectConflictResolutionImportSourceRowValue)
}

const getComparisonProjectSummaryOptionValues = async (db: AppQueryRunner, promptSelections: PromptSelection[]) => {
  const promptConfigs = await getComparisonProjectPromptConfigsForSelections(db, promptSelections)

  return getUniqueStringValues(
    promptConfigs.flatMap((promptConfig) => {
      return getComparisonProjectPromptTypeOptions(promptConfig.type)
    }),
  )
}

export const getConflictResolutionImportPlanResult = async (params: {
  importMode?: ComparisonProjectConflictResolutionImportMode
  promptSelections: PromptSelection[]
  scope: ComparisonProjectScope
  sourceComparisonProjectIds: string[]
  tx: AppQueryRunner
}) => {
  const sourceRows = await getConflictResolutionImportSourceRows(params.tx, params.sourceComparisonProjectIds)
  const targetArticles = await getConflictResolutionImportTargetArticles({
    sourceRows,
    scope: params.scope,
    tx: params.tx,
  })
  const targetSummaryOptionValues = await getComparisonProjectSummaryOptionValues(params.tx, params.promptSelections)
  const plan = getComparisonProjectConflictResolutionImportPlan({
    importMode: params.importMode,
    sourceRows,
    targetArticles,
    targetSummaryOptionValues,
  })

  if (plan.errors.length > 0) {
    throw getConflictResolutionImportRejectedError(
      plan.errors
        .map((error) => {
          return error.message
        })
        .join('; '),
    )
  }

  return {plan, sourceRows}
}
