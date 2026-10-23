import {Elysia, t} from 'elysia'

import {
  getComparisonJudgmentContextId,
  getValidatedComparisonJudgmentContext,
  upsertComparisonJudgmentContext,
} from '../../services/comparisonJudgmentContext.ts'
import {writeComparisonProjectConflictCommentImportChanges} from './comparisonProjectConflictComment.ts'
import type {ComparisonProjectConflictResolutionTransferArtifact} from './comparisonProjectConflictResolutionFileTransfer.ts'
import {
  type ComparisonProjectConflictResolutionImportSourceRow,
  getComparisonProjectConflictResolutionImportCommitResult,
} from './comparisonProjectConflictResolutionImport.ts'
import {
  type ComparisonProjectConflictResolutionImportCandidate,
  getComparisonProjectConflictResolutionImportCandidateSourceRow,
  getComparisonProjectConflictResolutionImportSourceRowsById,
} from './comparisonProjectConflictResolutionImportCandidates.ts'
import {
  getTransferReviewerDisplayNames,
  getTransferReviewerUserId,
  getUpsertTransferReviewersSql,
} from './comparisonProjectConflictResolutionProvenance.ts'
import {checkpointComparisonProjectMutation} from './comparisonProjectMutationCheckpoint.ts'
import {appDatabaseService} from './comparisonProjectRouteServices.ts'
import type {AppTx} from './comparisonProjectRouteTypes.ts'
import type {ComparisonProjectScope} from './comparisonProjectScopeTypes.ts'
import {getComparisonProjectConflictResolutionImportProvenanceResolver} from './getComparisonProjectConflictResolutionImportProvenanceResolver.ts'
import {getComparisonProjectScope} from './getComparisonProjectScope.ts'
import {getConflictResolutionArtifactImportAnalysis} from './getConflictResolutionArtifactImportAnalysis.ts'
import {insertComparisonProjectConflictResolutionImportCandidates} from './insertComparisonProjectConflictResolutionImportCandidates.ts'

const getComparisonProjectConflictResolutionTransferReviewer = (
  sourceRow: ComparisonProjectConflictResolutionImportSourceRow | null,
) => {
  const displayName = sourceRow?.sourceProvenance?.reviewerDisplayName?.trim() || null

  return {displayName, userId: displayName ? getTransferReviewerUserId(displayName) : null}
}

const getComparisonProjectConflictResolutionImportCandidateSourceRows = (params: {
  candidates: readonly ComparisonProjectConflictResolutionImportCandidate[]
  sourceRows: readonly ComparisonProjectConflictResolutionImportSourceRow[]
}) => {
  const sourceRowsById = getComparisonProjectConflictResolutionImportSourceRowsById(params.sourceRows)

  return params.candidates
    .map((candidate) => {
      return getComparisonProjectConflictResolutionImportCandidateSourceRow(candidate, sourceRowsById)
    })
    .filter((sourceRow): sourceRow is ComparisonProjectConflictResolutionImportSourceRow => {
      return sourceRow !== null
    })
}

const upsertComparisonProjectConflictResolutionTransferReviewers = async (params: {
  sourceRows: readonly ComparisonProjectConflictResolutionImportSourceRow[]
  tx: AppTx
}) => {
  const displayNames = getTransferReviewerDisplayNames(
    params.sourceRows.map((sourceRow) => {
      return sourceRow.sourceProvenance?.reviewerDisplayName
    }),
  )

  if (displayNames.length > 0) {
    await params.tx.run(getUpsertTransferReviewersSql(displayNames))
  }
}

const getComparisonProjectConflictResolutionTransferJudgmentContexts = (
  artifact: ComparisonProjectConflictResolutionTransferArtifact,
) => {
  return (artifact.judgmentContexts ?? [])
    .map((entry) => {
      const context = getValidatedComparisonJudgmentContext(entry.context)

      return context && getComparisonJudgmentContextId(context) === entry.id ? context : null
    })
    .filter((context): context is NonNullable<typeof context> => {
      return context !== null
    })
}

const upsertComparisonProjectConflictResolutionTransferJudgmentContexts = async (params: {
  artifact: ComparisonProjectConflictResolutionTransferArtifact
  sourceRows: readonly ComparisonProjectConflictResolutionImportSourceRow[]
  tx: AppTx
}) => {
  const usedContextIds = new Set(
    params.sourceRows.map((sourceRow) => {
      return sourceRow.sourceProvenance?.judgmentContextId ?? ''
    }),
  )
  const contexts = getComparisonProjectConflictResolutionTransferJudgmentContexts(params.artifact).filter((context) => {
    return usedContextIds.has(getComparisonJudgmentContextId(context))
  })

  await contexts.reduce<Promise<unknown>>((promise, context) => {
    return promise.then(() => {
      return upsertComparisonJudgmentContext(params.tx, context)
    })
  }, Promise.resolve())
}

const commitComparisonProjectConflictResolutionImport = async (scope: ComparisonProjectScope, body: unknown) => {
  return appDatabaseService.transaction(async (tx) => {
    const {analyzeResult, artifact, commentChanges, plan, sourceRows} =
      await getConflictResolutionArtifactImportAnalysis({body, scope, tx})
    const candidateSourceRows = getComparisonProjectConflictResolutionImportCandidateSourceRows({
      candidates: plan.candidates,
      sourceRows,
    })

    await upsertComparisonProjectConflictResolutionTransferReviewers({sourceRows: candidateSourceRows, tx})
    await upsertComparisonProjectConflictResolutionTransferJudgmentContexts({
      artifact,
      sourceRows: candidateSourceRows,
      tx,
    })
    const inserted = await insertComparisonProjectConflictResolutionImportCandidates({
      candidates: plan.candidates,
      comparisonProjectId: scope.id,
      getProvenance: getComparisonProjectConflictResolutionImportProvenanceResolver({
        origin: 'file-import',
        reviewer: getComparisonProjectConflictResolutionTransferReviewer,
        sourceRows,
      }),
      tx,
    })
    await writeComparisonProjectConflictCommentImportChanges({commentChanges, comparisonProjectId: scope.id, tx})

    return getComparisonProjectConflictResolutionImportCommitResult({analyzeResult, inserted})
  })
}

export const comparisonProjectsRoutesPostConflictResolutionsImportCommit = new Elysia().post(
  '/api/comparison-projects/:id/conflict-resolutions/import/commit',
  async (context) => {
    const {params, set} = context
    const scope = await getComparisonProjectScope(params.id)

    if (!scope) {
      set.status = 404
      return {data: null, error: 'Comparison project not found'}
    }

    const data = await commitComparisonProjectConflictResolutionImport(scope, context.body)
    await checkpointComparisonProjectMutation()

    return {data}
  },
  {body: t.Any()},
)
