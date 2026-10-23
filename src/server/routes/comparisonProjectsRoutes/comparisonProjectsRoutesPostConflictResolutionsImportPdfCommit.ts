import {Elysia, t} from 'elysia'

import {getQuotedStringList, getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {isComparisonJudgmentContextId} from '../../services/comparisonJudgmentContext.ts'
import {
  getComparisonProjectConflictCommentImportWrites,
  writeComparisonProjectConflictCommentImportChanges,
} from './comparisonProjectConflictComment.ts'
import {
  type ComparisonProjectConflictResolutionImportCommentChange,
  getComparisonProjectConflictResolutionImportCommitResult,
  getComparisonProjectConflictResolutionImportPlan,
} from './comparisonProjectConflictResolutionImport.ts'
import {getComparisonProjectConflictResolutionImportResolutionCandidates} from './comparisonProjectConflictResolutionImportCandidates.ts'
import {
  type ComparisonProjectConflictResolutionPdfImportBody,
  getComparisonProjectConflictResolutionPdfImportRequest,
} from './comparisonProjectConflictResolutionImportRequests.ts'
import {getImportedReviewerDisplayName} from './comparisonProjectConflictResolutionProvenance.ts'
import {checkpointComparisonProjectMutation} from './comparisonProjectMutationCheckpoint.ts'
import {comparisonProjectConflictResolutionTable} from './comparisonProjectRouteConstants.ts'
import {appDatabaseService} from './comparisonProjectRouteServices.ts'
import type {AppTx} from './comparisonProjectRouteTypes.ts'
import type {ComparisonProjectScope} from './comparisonProjectScopeTypes.ts'
import {getUniqueStringValues} from './comparisonProjectValueHelpers.ts'
import {getComparisonProjectConflictResolutionImportProvenanceResolver} from './getComparisonProjectConflictResolutionImportProvenanceResolver.ts'
import {getComparisonProjectScope} from './getComparisonProjectScope.ts'
import {getConflictResolutionArtifactImportAnalysis} from './getConflictResolutionArtifactImportAnalysis.ts'
import {getPdfImportAnalyzeResult} from './getPdfImportAnalyzeResult.ts'
import {getPdfUndecidedImportAnalysis} from './getPdfUndecidedImportAnalysis.ts'
import {insertComparisonProjectConflictResolutionImportCandidates} from './insertComparisonProjectConflictResolutionImportCandidates.ts'

const getPdfConflictResolutionImportReviewerId = (instanceId: string) => {
  const normalizedInstanceId = instanceId.trim().replace(/[^a-zA-Z0-9_.:-]/g, '_')

  return `pdf-import:${normalizedInstanceId || crypto.randomUUID()}`
}

const getOrCreatePdfConflictResolutionImportReviewer = async (params: {displayName?: string | null; tx: AppTx}) => {
  const reviewerId = getPdfConflictResolutionImportReviewerId(crypto.randomUUID())
  const reviewerName = getImportedReviewerDisplayName(params.displayName) ?? 'Unnamed reviewer'
  const [reviewer] = await params.tx.queryJson<{id: string; name: string}>(`
    INSERT INTO app.user_config (id, name, email, role, full_text_conversion_model_id, unpaywall_email)
    VALUES (
      ${getSqlLiteral(reviewerId)},
      ${getSqlLiteral(reviewerName)},
      ${getSqlLiteral(`${reviewerId}@pdf-import.forska.local`)},
      NULL,
      NULL,
      NULL
    )
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      updated_at = now()
    RETURNING id, name
  `)

  if (!reviewer) {
    throw new Error('Failed to create PDF import reviewer')
  }

  return reviewer
}

const clearComparisonProjectConflictResolutionImportCandidates = async (params: {
  candidates: ReturnType<typeof getComparisonProjectConflictResolutionImportPlan>['candidates']
  comparisonProjectId: string
  tx: AppTx
}) => {
  const targetArticleIds = getUniqueStringValues(
    params.candidates.map((candidate) => {
      return candidate.targetArticleId
    }),
  )

  if (targetArticleIds.length === 0) {
    return 0
  }

  const deletedRows = await params.tx.queryJson<{articleId: string}>(`
    DELETE FROM ${comparisonProjectConflictResolutionTable}
    WHERE comparison_project_id = ${getSqlLiteral(params.comparisonProjectId)}
      AND article_id IN (${getQuotedStringList(targetArticleIds).join(', ')})
    RETURNING article_id AS articleId
  `)

  return deletedRows.length
}

const getPdfImportCommentChanges = (
  commentChanges: readonly ComparisonProjectConflictResolutionImportCommentChange[],
  reviewer: {id: string; name: string} | null,
) => {
  return commentChanges.map((commentChange) => {
    return {...commentChange, authorDisplayName: reviewer?.name ?? null, authorUserId: reviewer?.id ?? null}
  })
}

const commitComparisonProjectConflictResolutionPdfImport = async (
  scope: ComparisonProjectScope,
  body: ComparisonProjectConflictResolutionPdfImportBody,
) => {
  return appDatabaseService.transaction(async (tx) => {
    const {artifact, importMode, overwriteMode, parsedImport, pdfUndecidedMode, pdfWarnings, reviewer} =
      await getComparisonProjectConflictResolutionPdfImportRequest(scope, body)
    const {analyzeResult, commentChanges, plan, sourceRows} = await getConflictResolutionArtifactImportAnalysis({
      body: {artifact, importMode, overwriteMode},
      scope,
      tx,
    })
    const pdfAnalyzeResult = await getPdfImportAnalyzeResult({
      analyzeResult,
      importMode,
      parsedImport,
      pdfUndecidedMode,
      pdfWarnings,
      reviewer,
      scope,
      tx,
    })
    const importedReviewer =
      getComparisonProjectConflictResolutionImportResolutionCandidates(plan.candidates).length === 0
      && getComparisonProjectConflictCommentImportWrites(commentChanges).length === 0
        ? null
        : await getOrCreatePdfConflictResolutionImportReviewer({displayName: reviewer.displayName, tx})
    const pdfJudgmentContextId = isComparisonJudgmentContextId(parsedImport.source.judgmentContextId)
      ? parsedImport.source.judgmentContextId
      : null
    const inserted = await insertComparisonProjectConflictResolutionImportCandidates({
      candidates: plan.candidates,
      comparisonProjectId: scope.id,
      getProvenance: getComparisonProjectConflictResolutionImportProvenanceResolver({
        judgmentContextId: () => {
          return pdfJudgmentContextId
        },
        origin: 'pdf-import',
        reviewer: () => {
          return {displayName: importedReviewer?.name ?? null, userId: importedReviewer?.id ?? null}
        },
        sourceRows,
      }),
      tx,
    })
    await writeComparisonProjectConflictCommentImportChanges({
      commentChanges: getPdfImportCommentChanges(commentChanges, importedReviewer),
      comparisonProjectId: scope.id,
      tx,
    })
    const cleared =
      pdfUndecidedMode === 'clear' && parsedImport.undecidedRows.length > 0
        ? await clearComparisonProjectConflictResolutionImportCandidates({
            candidates: (await getPdfUndecidedImportAnalysis({importMode, parsedImport, scope, tx})).plan.candidates,
            comparisonProjectId: scope.id,
            tx,
          })
        : 0

    return getComparisonProjectConflictResolutionImportCommitResult({
      analyzeResult: pdfAnalyzeResult,
      inserted,
      cleared,
    })
  })
}

export const comparisonProjectsRoutesPostConflictResolutionsImportPdfCommit = new Elysia().post(
  '/api/comparison-projects/:id/conflict-resolutions/import/pdf/commit',
  async (context) => {
    const {params, set} = context
    const scope = await getComparisonProjectScope(params.id)

    if (!scope) {
      set.status = 404
      return {data: null, error: 'Comparison project not found'}
    }

    const data = await commitComparisonProjectConflictResolutionPdfImport(scope, context.body)
    await checkpointComparisonProjectMutation()

    return {data}
  },
  {
    body: t.Object({
      file: t.File(),
      importMode: t.Optional(t.String()),
      overwriteMode: t.Optional(t.String()),
      pdfUndecidedMode: t.Optional(t.String()),
    }),
  },
)
