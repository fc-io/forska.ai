import {Elysia, t} from 'elysia'

import type {ProjectPromptCriteriaDisposition} from '../../db/schemaTypes.ts'
import {
  appendProviderModelThinkingBadgeLabel,
  getProviderModelThinkingBadgeValue,
} from '../../utils/providerModelLabel.ts'
import {getProviderModelMetadataOptions} from '../providers/providerModelMetadata.ts'
import {assertSelectableProviderModelId} from '../providers/providerModelRepository.ts'
import {appendHumanJudgmentReviewServingDeltas} from '../reviewServing/humanJudgmentReviewServingDeltaService.ts'
import {appendLlmJudgmentReviewServingDeltas} from '../reviewServing/llmJudgmentReviewServingDeltaService.ts'
import {appendProjectScopeArticleReviewServingDeltas} from '../reviewServing/projectScopeReviewServingDeltaService.ts'
import {
  appendProjectReviewConfigReviewServingDelta,
  appendPromptConfigReviewServingDelta,
  type ProjectReviewConfigReviewServingField,
  type PromptConfigReviewServingField,
} from '../reviewServing/reviewConfigReviewServingDeltaService.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {
  escapeSqlString,
  getDateValue,
  getJsonValue,
  getQuotedStringList,
  getSqlLiteral,
  getTimestampLiteral,
} from '../services/appQueryHelpers.ts'
import {getComparisonProjectServingRebuildService} from '../services/comparisonProjectServingRebuildService.ts'
import {
  getOrCreateImmutablePromptTx,
  immutablePromptIdentityReviewServingFields,
} from '../services/immutablePromptService.ts'
import {getProjectMartDirtyRefreshStateService} from '../services/projectMartDirtyRefreshStateService.ts'
import {getProjectMartLargeRebuildStateService} from '../services/projectMartLargeRebuildStateService.ts'
import {HttpError} from '../utils/httpError.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'
import {assertProjectIsActive, getProjectAccess} from './projectsRoutes/projectAccessGuard.ts'
import {projectsRoutesGetArticlesReviews} from './projectsRoutes/projectsRoutesGetArticlesReviews.ts'
import {projectsRoutesGetArticlesReviewsBoth} from './projectsRoutes/projectsRoutesGetArticlesReviewsBoth.ts'
import {projectsRoutesGetArticlesReviewsCount} from './projectsRoutes/projectsRoutesGetArticlesReviewsCount.ts'
import {projectsRoutesGetArticlesReviewsFilters} from './projectsRoutes/projectsRoutesGetArticlesReviewsFilters.ts'
import {projectsRoutesGetArticlesReviewsHuman} from './projectsRoutes/projectsRoutesGetArticlesReviewsHuman.ts'
import {projectsRoutesGetArticlesReviewsHumanFilters} from './projectsRoutes/projectsRoutesGetArticlesReviewsHumanFilters.ts'
import {projectsRoutesGetArticlesReviewsUnassessed} from './projectsRoutes/projectsRoutesGetArticlesReviewsUnassessed.ts'
import {projectsRoutesGetPromptPreview} from './projectsRoutes/projectsRoutesGetPromptPreview.ts'
import {projectsRoutesGetReviewsWarnings} from './projectsRoutes/projectsRoutesGetReviewsWarnings.ts'
import {projectsRoutesPostArticleReviewDetails} from './projectsRoutes/projectsRoutesPostArticleReviewDetails.ts'
import {projectsRoutesPostDeleteArchived} from './projectsRoutes/projectsRoutesPostDeleteArchived.ts'

const parseOptionalDate = (value?: string | null) => {
  if (!value) {
    return null
  }
  const trimmedValue = value.trim()
  if (!trimmedValue) {
    return null
  }
  const isoDateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/
  const hasIsoDateOnlyMatch = isoDateOnlyPattern.exec(trimmedValue)
  const normalizedValue = hasIsoDateOnlyMatch ? `${trimmedValue}T00:00:00.000Z` : trimmedValue
  const parsedDate = new Date(normalizedValue)
  if (Number.isNaN(parsedDate.getTime())) {
    throw new Error('Invalid date value provided')
  }
  return parsedDate
}

const getProjectModelLabel = ({
  metadataJson,
  modelName,
  provider,
  version,
}: {
  metadataJson: unknown
  modelName: string | null
  provider: string | null
  version: string | null
}) => {
  return modelName
    ? appendProviderModelThinkingBadgeLabel({
        label: modelName,
        thinking: getProviderModelThinkingBadgeValue({
          provider,
          thinking: getProviderModelMetadataOptions(getJsonValue(metadataJson)).thinking,
          version,
        }),
      })
    : modelName
}

type AppQueryRunner = {queryJson: <T>(statement: string) => Promise<T[]>}
type AppTx = AppQueryRunner & {run: (statement: string) => Promise<void>}

type ProjectEditPromptPayload = {
  archived?: boolean
  enabled?: boolean
  order: number
  originalId?: string
  originalText: string
  promptHeading?: string
  type?: string
}

type ExistingProjectPromptAssociation = {
  archived: boolean
  criteriaDisposition: ProjectPromptCriteriaDisposition | null
  criteriaSectionKey: string | null
  criteriaSectionLabel: string | null
  enabled: boolean
  id: string
  originProjectId: string | null
  promptId: string
}

type ResolvedProjectPromptEdit = {
  archived: boolean | undefined
  changedPromptConfigFields: PromptConfigReviewServingField[]
  currentAssociation: ExistingProjectPromptAssociation | undefined
  enabled: boolean | undefined
  order: number
  originalId: string | undefined
  shouldDeleteOriginalAssociation: boolean
  targetPromptId: string
}

type ChangedProjectPromptLink = {
  newPromptId: string | null
  oldPromptId: string
  projectPromptId: string
  reason: 'removed' | 'replaced'
}

type ProjectPromptLlmCleanupSummary = {
  keptSharedLlmJudgments: number
  skippedComparisonPromptReferencedJudgments: number
  softDeletedLlmJudgments: number
}

type ProjectPromptCleanupSummary = ProjectPromptLlmCleanupSummary & {
  changedPromptLinks: ChangedProjectPromptLink[]
  deletedHumanPromptAnswers: number
}

const logProjectPromptCleanupSummary = (params: {projectId: string; summary: ProjectPromptCleanupSummary}) => {
  console.log(
    JSON.stringify({
      changedPromptLinks: params.summary.changedPromptLinks.map((link) => {
        return {newPromptId: link.newPromptId, oldPromptId: link.oldPromptId, projectPromptId: link.projectPromptId}
      }),
      deletedHumanPromptAnswers: params.summary.deletedHumanPromptAnswers,
      event: 'project_prompt_cleanup_summary',
      keptSharedLlmJudgments: params.summary.keptSharedLlmJudgments,
      projectId: params.projectId,
      skippedComparisonPromptReferencedJudgments: params.summary.skippedComparisonPromptReferencedJudgments,
      softDeletedLlmJudgments: params.summary.softDeletedLlmJudgments,
    }),
  )
}

const getComparisonProjectIdsAffectedByProjectPromptEdit = async (db: AppQueryRunner, projectId: string) => {
  return db.queryJson<{comparisonProjectId: string}>(`
    SELECT DISTINCT comparison_project.id AS comparisonProjectId
    FROM app.comparison_project comparison_project
    LEFT JOIN app.comparison_project_source_project source_project
      ON source_project.comparison_project_id = comparison_project.id
     AND source_project.source_project_id = '${escapeSqlString(projectId)}'
    WHERE comparison_project.archived = FALSE
      AND (
        source_project.id IS NOT NULL
        OR comparison_project.summary_source_project_id = '${escapeSqlString(projectId)}'
      )
  `)
}

const markComparisonServingStaleForProjectPromptEditTx = async (tx: AppTx, projectId: string) => {
  const comparisonProjectRows = await getComparisonProjectIdsAffectedByProjectPromptEdit(tx, projectId)
  await getComparisonProjectServingRebuildService().markComparisonProjectsServingStaleTx(
    comparisonProjectRows.map((row) => {
      return row.comparisonProjectId
    }),
    tx,
  )
}

type ProjectEditJudgmentJob = {
  id: string
  lastImportCompletedAt: unknown
  lastImportStartedAt: unknown
  status: string
  storageState: string
}

type ProjectEditJobSqliteHealthProjection = {
  claimedOutboxCount: number | null
  hasPendingCompletionAck: boolean | null
  orphanedJudgedRowCount: number | null
  outboxRowCount: number | null
  pendingCompletionAckCount: number | null
  promptClaimedCount: number | null
  promptReadyCount: number | null
  promptRunningCount: number | null
}

type ProjectPromptLlmCleanupCandidateRow = {
  articleId: string
  comparisonPromptReferenced: boolean
  id: string
  modelId: string
  projectId: string | null
  promptId: string
  sharedProjectReferenced: boolean
  updatedAt: string | null
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}

type ProjectEditCurrentProject = {
  dateFrom: unknown
  dateTo: unknown
  humanJudgmentMode: 'prompt' | 'summary' | null
  id: string
  modelId: string
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}

type ExistingProjectPromptComparisonRow = ExistingProjectPromptAssociation & {
  order: number | null
  originalText: string
  promptHeading: string | null
  type: string | null
}

type ProjectRow = {
  humanJudgmentMode?: 'prompt' | 'summary' | null
  id: string
  name: string
  description: string | null
  modelId: string
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  dateFrom: unknown
  dateTo: unknown
  archived: boolean
  createdAt: unknown
  updatedAt: unknown
}

const getProjectValue = (row: ProjectRow) => {
  return {
    ...row,
    dateFrom: getDateValue(row.dateFrom),
    dateTo: getDateValue(row.dateTo),
    createdAt: getDateValue(row.createdAt),
    updatedAt: getDateValue(row.updatedAt),
  }
}

const getProjectRowSql = (projectId: string) => {
  return `
    SELECT
      id,
      name,
      description,
      model_id AS modelId,
      use_title AS useTitle,
      use_abstract AS useAbstract,
      use_fulltext AS useFulltext,
      use_fulltext_no_images AS useFulltextNoImages,
      human_judgment_mode AS humanJudgmentMode,
      date_from AS dateFrom,
      date_to AS dateTo,
      archived,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM app.project
    WHERE id = '${escapeSqlString(projectId)}'
      AND delete_pending_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM app.archived_project_delete_tombstone tombstone
        WHERE tombstone.project_id = app.project.id
          AND tombstone.completed_at IS NULL
      )
    LIMIT 1
  `
}

const getProjectRow = async (db: AppQueryRunner, projectId: string) => {
  const [project] = await db.queryJson<ProjectRow>(getProjectRowSql(projectId))
  return project ?? null
}

const updateProjectTx = async (tx: AppTx, params: {projectId: string; updateParts: string[]}) => {
  await tx.run(`
    UPDATE app.project
    SET ${params.updateParts.join(', ')}
    WHERE id = '${escapeSqlString(params.projectId)}'
      AND delete_pending_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM app.archived_project_delete_tombstone tombstone
        WHERE tombstone.project_id = app.project.id
          AND tombstone.completed_at IS NULL
      )
  `)

  return getProjectRow(tx, params.projectId)
}

const getDuplicateTargetPromptIds = (targetPromptIds: string[]) => {
  const duplicateState = targetPromptIds.reduce(
    (state, targetPromptId) => {
      if (state.seenTargetPromptIds.has(targetPromptId)) {
        state.duplicateTargetPromptIds.add(targetPromptId)
      }
      state.seenTargetPromptIds.add(targetPromptId)
      return state
    },
    {duplicateTargetPromptIds: new Set<string>(), seenTargetPromptIds: new Set<string>()},
  )

  return Array.from(duplicateState.duplicateTargetPromptIds)
}

const getPromptMetadataValue = (value: string | null | undefined) => {
  return value === undefined ? undefined : value === null || value.trim().length === 0 ? null : value
}

const getDateTime = (value: Date | null) => {
  return value === null ? null : value.getTime()
}

const getNumberOrZero = (value: number | null | undefined) => {
  return Number(value ?? 0)
}

const hasDateEditChanged = (value: Date | null | undefined, currentValue: unknown) => {
  return value !== undefined && getDateTime(value) !== getDateTime(getDateValue(currentValue))
}

const getUniqueSortedStrings = (values: string[]) => {
  return Array.from(
    new Set(
      values.filter((value) => {
        return typeof value === 'string' && value.trim() !== ''
      }),
    ),
  ).sort((a, b) => {
    return a.localeCompare(b)
  })
}

const hasSameStringSet = (left: string[], right: string[]) => {
  const leftValues = getUniqueSortedStrings(left)
  const rightValues = getUniqueSortedStrings(right)
  return (
    leftValues.length === rightValues.length
    && leftValues.every((value, index) => {
      return value === rightValues[index]
    })
  )
}

const getChangedProtectedProjectEditFields = ({
  body,
  currentImportRoutes,
  currentProject,
  parsedDateFrom,
  parsedDateTo,
}: {
  body: {
    dateFrom?: string | null
    dateTo?: string | null
    humanJudgmentMode?: 'prompt' | 'summary'
    importRoutes?: string[]
    modelId?: string
    useAbstract?: boolean
    useFulltext?: boolean
    useFulltextNoImages?: boolean
    useTitle?: boolean
  }
  currentImportRoutes: string[]
  currentProject: ProjectEditCurrentProject
  parsedDateFrom: Date | null | undefined
  parsedDateTo: Date | null | undefined
}) => {
  return [
    body.modelId !== undefined && body.modelId !== currentProject.modelId ? 'modelId' : null,
    body.useTitle !== undefined && body.useTitle !== currentProject.useTitle ? 'useTitle' : null,
    body.useAbstract !== undefined && body.useAbstract !== currentProject.useAbstract ? 'useAbstract' : null,
    body.useFulltext !== undefined && body.useFulltext !== currentProject.useFulltext ? 'useFulltext' : null,
    body.useFulltextNoImages !== undefined && body.useFulltextNoImages !== currentProject.useFulltextNoImages
      ? 'useFulltextNoImages'
      : null,
    body.humanJudgmentMode !== undefined && body.humanJudgmentMode !== (currentProject.humanJudgmentMode ?? 'prompt')
      ? 'humanJudgmentMode'
      : null,
    hasDateEditChanged(parsedDateFrom, currentProject.dateFrom) ? 'dateFrom' : null,
    hasDateEditChanged(parsedDateTo, currentProject.dateTo) ? 'dateTo' : null,
    body.importRoutes !== undefined && !hasSameStringSet(body.importRoutes, currentImportRoutes)
      ? 'importRoutes'
      : null,
  ].filter((field): field is string => {
    return field !== null
  })
}

const getEffectiveSubmittedPromptEdits = (
  submittedPrompts: ProjectEditPromptPayload[],
  existingPromptIds: Set<string>,
) => {
  return submittedPrompts
    .filter((prompt) => {
      return (prompt.originalText ?? '').trim() !== ''
    })
    .filter((prompt) => {
      return !prompt.originalId || existingPromptIds.has(prompt.originalId) || prompt.enabled === true
    })
}

const getHasProjectPromptEditChanges = ({
  existingPrompts,
  submittedPrompts,
}: {
  existingPrompts: ExistingProjectPromptComparisonRow[]
  submittedPrompts: ProjectEditPromptPayload[] | undefined
}) => {
  if (submittedPrompts === undefined) {
    return false
  }

  const existingByPromptId = new Map(
    existingPrompts.map((prompt) => {
      return [prompt.promptId, prompt]
    }),
  )
  const existingPromptIds = new Set(
    existingPrompts.map((prompt) => {
      return prompt.promptId
    }),
  )
  const effectiveSubmittedPrompts = getEffectiveSubmittedPromptEdits(submittedPrompts, existingPromptIds)
  const receivedOriginalIds = new Set(
    effectiveSubmittedPrompts
      .map((prompt) => {
        return prompt.originalId
      })
      .filter((id): id is string => {
        return typeof id === 'string'
      }),
  )
  const hasRemovedPrompt = existingPrompts.some((prompt) => {
    return !receivedOriginalIds.has(prompt.promptId)
  })

  return (
    hasRemovedPrompt
    || effectiveSubmittedPrompts.some((prompt) => {
      if (!prompt.originalId) {
        return true
      }

      const existingPrompt = existingByPromptId.get(prompt.originalId)
      if (!existingPrompt) {
        return true
      }

      const existingPromptHeading = getPromptMetadataValue(existingPrompt.promptHeading) ?? null
      const existingPromptType = getPromptMetadataValue(existingPrompt.type) ?? null
      const promptHeading = getPromptMetadataValue(prompt.promptHeading)
      const promptType = getPromptMetadataValue(prompt.type)
      const targetPromptHeading = promptHeading === undefined ? existingPromptHeading : promptHeading
      const targetPromptType = promptType === undefined ? existingPromptType : promptType
      const hasArchivedChange = typeof prompt.archived === 'boolean' && prompt.archived !== existingPrompt.archived
      const hasEnabledChange = typeof prompt.enabled === 'boolean' && prompt.enabled !== existingPrompt.enabled

      return (
        prompt.originalText !== existingPrompt.originalText
        || targetPromptHeading !== existingPromptHeading
        || targetPromptType !== existingPromptType
        || prompt.order !== existingPrompt.order
        || hasArchivedChange
        || hasEnabledChange
      )
    })
  )
}

const getCurrentProjectImportRoutes = async (projectId: string) => {
  const rows = await getAppDatabaseService().queryJson<{route: string}>(`
    SELECT ir.route AS route
    FROM app.project_import_route pir
    INNER JOIN app.import_route ir ON ir.id = pir.import_route_id
    WHERE pir.project_id = '${escapeSqlString(projectId)}'
  `)

  return rows.map((row) => {
    return row.route
  })
}

const promptEditSafeJobStatuses = new Set(['paused', 'completed'])

const hasPromptEditJobImportInFlight = (job: ProjectEditJudgmentJob) => {
  const startedAt = getDateValue(job.lastImportStartedAt)
  const completedAt = getDateValue(job.lastImportCompletedAt)

  return Boolean(startedAt && (!completedAt || completedAt < startedAt))
}

const hasUnsafePromptEditSqliteHealth = (projection: ProjectEditJobSqliteHealthProjection) => {
  return (
    getNumberOrZero(projection.outboxRowCount) > 0
    || getNumberOrZero(projection.claimedOutboxCount) > 0
    || getNumberOrZero(projection.orphanedJudgedRowCount) > 0
    || getNumberOrZero(projection.pendingCompletionAckCount) > 0
    || getNumberOrZero(projection.promptReadyCount) > 0
    || getNumberOrZero(projection.promptClaimedCount) > 0
    || getNumberOrZero(projection.promptRunningCount) > 0
    || Boolean(projection.hasPendingCompletionAck)
  )
}

const getFreshPromptEditSqliteHealthProjection = async (db: AppQueryRunner, jobId: string) => {
  const [projection] = await db.queryJson<ProjectEditJobSqliteHealthProjection>(`
    SELECT
      outbox_row_count AS outboxRowCount,
      claimed_outbox_count AS claimedOutboxCount,
      orphaned_judged_row_count AS orphanedJudgedRowCount,
      pending_completion_ack_count AS pendingCompletionAckCount,
      has_pending_completion_ack AS hasPendingCompletionAck,
      prompt_ready_count AS promptReadyCount,
      prompt_claimed_count AS promptClaimedCount,
      prompt_running_count AS promptRunningCount
    FROM app.judgment_job_sqlite_health_projection
    WHERE job_id = '${escapeSqlString(jobId)}'
      AND fresh_until_at > current_timestamp
    LIMIT 1
  `)

  return projection ?? null
}

const canEditPromptsWithJudgmentJob = async (db: AppQueryRunner, job: ProjectEditJudgmentJob) => {
  if (!promptEditSafeJobStatuses.has(job.status) || job.storageState === 'quarantined') {
    return false
  }

  if (hasPromptEditJobImportInFlight(job)) {
    return false
  }

  if (job.storageState === 'drained') {
    return true
  }

  const projection = await getFreshPromptEditSqliteHealthProjection(db, job.id)

  return projection !== null && !hasUnsafePromptEditSqliteHealth(projection)
}

const getChangedProjectPromptLinks = ({
  removedAssociations,
  resolvedPromptEdits,
}: {
  removedAssociations: ExistingProjectPromptAssociation[]
  resolvedPromptEdits: ResolvedProjectPromptEdit[]
}) => {
  const finalTargetPromptIds = new Set(
    resolvedPromptEdits.map((promptEdit) => {
      return promptEdit.targetPromptId
    }),
  )
  const replacedLinks = resolvedPromptEdits.flatMap((promptEdit): ChangedProjectPromptLink[] => {
    return promptEdit.shouldDeleteOriginalAssociation
      && promptEdit.originalId
      && promptEdit.currentAssociation
      && !finalTargetPromptIds.has(promptEdit.originalId)
      ? [
          {
            newPromptId: promptEdit.targetPromptId,
            oldPromptId: promptEdit.originalId,
            projectPromptId: promptEdit.currentAssociation.id,
            reason: 'replaced',
          },
        ]
      : []
  })
  const removedLinks = removedAssociations.map((entry): ChangedProjectPromptLink => {
    return {newPromptId: null, oldPromptId: entry.promptId, projectPromptId: entry.id, reason: 'removed'}
  })

  return [...replacedLinks, ...removedLinks]
}

const getChangedReviewConfigFields = (params: {
  hasImportRouteChanges: boolean
  hasModelIdUpdate: boolean
  hasPromptChanges: boolean
  currentProject: ProjectEditCurrentProject
  body: {
    humanJudgmentMode?: 'prompt' | 'summary'
    useAbstract?: boolean
    useFulltext?: boolean
    useFulltextNoImages?: boolean
    useTitle?: boolean
  }
}) => {
  return [
    params.hasModelIdUpdate ? 'modelId' : null,
    params.hasModelIdUpdate ? 'modelExecutionIdentity' : null,
    params.body.useTitle !== undefined && params.body.useTitle !== params.currentProject.useTitle ? 'useTitle' : null,
    params.body.useAbstract !== undefined && params.body.useAbstract !== params.currentProject.useAbstract
      ? 'useAbstract'
      : null,
    params.body.useFulltext !== undefined && params.body.useFulltext !== params.currentProject.useFulltext
      ? 'useFulltext'
      : null,
    params.body.useFulltextNoImages !== undefined
    && params.body.useFulltextNoImages !== params.currentProject.useFulltextNoImages
      ? 'useFulltextNoImages'
      : null,
    params.body.humanJudgmentMode !== undefined
    && params.body.humanJudgmentMode !== (params.currentProject.humanJudgmentMode ?? 'prompt')
      ? 'humanJudgmentMode'
      : null,
    params.hasPromptChanges ? 'promptMembership' : null,
    params.hasImportRouteChanges ? 'importRoutes' : null,
  ].filter((field): field is ProjectReviewConfigReviewServingField => {
    return field !== null
  })
}

const appendProjectReviewConfigDeltaIfNeeded = async (
  tx: AppTx,
  params: {
    changedReviewConfigFields: ProjectReviewConfigReviewServingField[]
    projectId: string
    sourceMutationKey: string
    sourceOperation: 'insert' | 'update' | 'upsert'
    sourceTable?: string
  },
) => {
  return params.changedReviewConfigFields.length === 0
    ? undefined
    : await appendProjectReviewConfigReviewServingDelta(tx, {
        changedReviewConfigFields: params.changedReviewConfigFields,
        projectId: params.projectId,
        sourceMutationKey: params.sourceMutationKey,
        sourceOperation: params.sourceOperation,
        sourceTable: params.sourceTable,
      })
}

const deleteProjectHumanPromptAnswersForChangedPromptLinksTx = async (
  tx: AppTx,
  params: {changedPromptLinks: ChangedProjectPromptLink[]; projectId: string},
) => {
  const oldPromptIds = getUniqueSortedStrings(
    params.changedPromptLinks.map((link) => {
      return link.oldPromptId
    }),
  )

  if (oldPromptIds.length === 0) {
    return 0
  }

  const oldPromptIdList = getQuotedStringList(oldPromptIds).join(', ')
  const [countRow] = await tx.queryJson<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.judgment_human
    WHERE project_id = '${escapeSqlString(params.projectId)}'
      AND prompt_id IN (${oldPromptIdList})
  `)

  await tx.run(`
    DELETE FROM app.judgment_human
    WHERE project_id = '${escapeSqlString(params.projectId)}'
      AND prompt_id IN (${oldPromptIdList})
  `)

  return Number(countRow?.count ?? 0)
}

const getProjectPromptLlmCleanupEmptySummary = (): ProjectPromptLlmCleanupSummary => {
  return {keptSharedLlmJudgments: 0, skippedComparisonPromptReferencedJudgments: 0, softDeletedLlmJudgments: 0}
}

const getProjectPromptLlmCleanupCandidateRowsTx = async (
  tx: AppTx,
  params: {oldPromptIds: string[]; projectId: string},
) => {
  return tx.queryJson<ProjectPromptLlmCleanupCandidateRow>(`
    WITH old_prompt(prompt_id) AS (
      VALUES ${params.oldPromptIds
        .map((promptId) => {
          return `('${escapeSqlString(promptId)}')`
        })
        .join(', ')}
    ),
    candidate AS (
      SELECT
        judgment.id,
        judgment.article_id,
        judgment.model_id,
        judgment.project_id,
        judgment.prompt_id,
        judgment.updated_at,
        judgment.use_abstract,
        judgment.use_fulltext,
        judgment.use_fulltext_no_images,
        judgment.use_title
      FROM app.judgment judgment
      INNER JOIN old_prompt ON old_prompt.prompt_id = judgment.prompt_id
      INNER JOIN app.project project ON project.id = '${escapeSqlString(params.projectId)}'
      INNER JOIN app.article article ON article.id = judgment.article_id
      WHERE judgment.deleted_at IS NULL
        AND judgment.model_id = project.model_id
        AND judgment.use_title = project.use_title
        AND judgment.use_abstract = project.use_abstract
        AND judgment.use_fulltext = project.use_fulltext
        AND judgment.use_fulltext_no_images = project.use_fulltext_no_images
        AND project.archived = FALSE
        AND project.delete_pending_at IS NULL
        AND (project.date_from IS NULL OR article.article_created_at >= project.date_from)
        AND (project.date_to IS NULL OR article.article_created_at <= project.date_to)
        AND NOT EXISTS (
          SELECT 1
          FROM app.archived_project_delete_tombstone tombstone
          WHERE tombstone.project_id = project.id
            AND tombstone.completed_at IS NULL
        )
        AND (
          EXISTS (
            SELECT 1
            FROM app.project_article project_article
            WHERE project_article.project_id = project.id
              AND project_article.article_id = judgment.article_id
          )
          OR EXISTS (
            SELECT 1
            FROM app.project_import_route project_import_route
            INNER JOIN app.article_import_route article_import_route
              ON article_import_route.import_route_id = project_import_route.import_route_id
            WHERE project_import_route.project_id = project.id
              AND article_import_route.article_id = judgment.article_id
          )
        )
    )
    SELECT
      candidate.id AS id,
      candidate.article_id AS articleId,
      candidate.model_id AS modelId,
      candidate.project_id AS projectId,
      candidate.prompt_id AS promptId,
      candidate.updated_at AS updatedAt,
      candidate.use_abstract AS useAbstract,
      candidate.use_fulltext AS useFulltext,
      candidate.use_fulltext_no_images AS useFulltextNoImages,
      candidate.use_title AS useTitle,
      EXISTS (
        SELECT 1
        FROM app.comparison_project_prompt comparison_prompt
        INNER JOIN app.comparison_project comparison_project
          ON comparison_project.id = comparison_prompt.comparison_project_id
        WHERE comparison_prompt.prompt_id = candidate.prompt_id
          AND comparison_project.archived = FALSE
      ) AS comparisonPromptReferenced,
      EXISTS (
        SELECT 1
        FROM app.project other_project
        INNER JOIN app.project_prompt other_project_prompt
          ON other_project_prompt.project_id = other_project.id
        INNER JOIN app.article other_article ON other_article.id = candidate.article_id
        WHERE other_project.id <> '${escapeSqlString(params.projectId)}'
          AND other_project_prompt.prompt_id = candidate.prompt_id
          AND other_project_prompt.enabled = TRUE
          AND other_project.archived = FALSE
          AND other_project.delete_pending_at IS NULL
          AND other_project.model_id = (
            SELECT project.model_id FROM app.project project WHERE project.id = '${escapeSqlString(params.projectId)}'
          )
          AND other_project.use_title = (
            SELECT project.use_title FROM app.project project WHERE project.id = '${escapeSqlString(params.projectId)}'
          )
          AND other_project.use_abstract = (
            SELECT project.use_abstract FROM app.project project WHERE project.id = '${escapeSqlString(params.projectId)}'
          )
          AND other_project.use_fulltext = (
            SELECT project.use_fulltext FROM app.project project WHERE project.id = '${escapeSqlString(params.projectId)}'
          )
          AND other_project.use_fulltext_no_images = (
            SELECT project.use_fulltext_no_images FROM app.project project WHERE project.id = '${escapeSqlString(params.projectId)}'
          )
          AND (other_project.date_from IS NULL OR other_article.article_created_at >= other_project.date_from)
          AND (other_project.date_to IS NULL OR other_article.article_created_at <= other_project.date_to)
          AND NOT EXISTS (
            SELECT 1
            FROM app.archived_project_delete_tombstone tombstone
            WHERE tombstone.project_id = other_project.id
              AND tombstone.completed_at IS NULL
          )
          AND (
            EXISTS (
              SELECT 1
              FROM app.project_article other_project_article
              WHERE other_project_article.project_id = other_project.id
                AND other_project_article.article_id = candidate.article_id
            )
            OR EXISTS (
              SELECT 1
              FROM app.project_import_route other_project_import_route
              INNER JOIN app.article_import_route other_article_import_route
                ON other_article_import_route.import_route_id = other_project_import_route.import_route_id
              WHERE other_project_import_route.project_id = other_project.id
                AND other_article_import_route.article_id = candidate.article_id
            )
          )
      ) AS sharedProjectReferenced
    FROM candidate
  `)
}

const softDeleteProjectPromptLlmJudgmentsTx = async (
  tx: AppTx,
  params: {changedPromptLinks: ChangedProjectPromptLink[]; projectId: string},
) => {
  const oldPromptIds = getUniqueSortedStrings(
    params.changedPromptLinks.map((link) => {
      return link.oldPromptId
    }),
  )

  if (oldPromptIds.length === 0) {
    return getProjectPromptLlmCleanupEmptySummary()
  }

  const candidateRows = await getProjectPromptLlmCleanupCandidateRowsTx(tx, {oldPromptIds, projectId: params.projectId})
  const softDeleteIds = candidateRows
    .filter((row) => {
      return !row.comparisonPromptReferenced && !row.sharedProjectReferenced
    })
    .map((row) => {
      return row.id
    })

  if (softDeleteIds.length > 0) {
    await appendLlmJudgmentReviewServingDeltas(
      tx,
      candidateRows
        .filter((row) => {
          return softDeleteIds.includes(row.id)
        })
        .map((row) => {
          return {
            articleId: row.articleId,
            changeKind: 'judgment.llm.deleted' as const,
            judgmentId: row.id,
            modelId: row.modelId,
            projectId: row.projectId,
            promptId: row.promptId,
            sourceMutationKey: `projectPromptCleanup|${params.projectId}|${row.id}`,
            sourceOperation: 'delete' as const,
            sourceUpdatedAt: row.updatedAt,
            useAbstract: row.useAbstract,
            useFulltext: row.useFulltext,
            useFulltextNoImages: row.useFulltextNoImages,
            useTitle: row.useTitle,
          }
        }),
    )
    await tx.run(`
      UPDATE app.judgment AS judgment
      SET deleted_at = current_timestamp,
          updated_at = current_timestamp,
          delete_generation = (
            SELECT COALESCE(MAX(existing.delete_generation), judgment.delete_generation) + 1
            FROM app.judgment existing
            WHERE existing.article_id = judgment.article_id
              AND existing.prompt_id = judgment.prompt_id
              AND existing.model_id = judgment.model_id
              AND existing.use_title = judgment.use_title
              AND existing.use_abstract = judgment.use_abstract
              AND existing.use_fulltext = judgment.use_fulltext
              AND existing.use_fulltext_no_images = judgment.use_fulltext_no_images
          )
      WHERE judgment.id IN (${getQuotedStringList(softDeleteIds).join(', ')})
    `)
  }

  return {
    keptSharedLlmJudgments: candidateRows.filter((row) => {
      return row.sharedProjectReferenced
    }).length,
    skippedComparisonPromptReferencedJudgments: candidateRows.filter((row) => {
      return row.comparisonPromptReferenced
    }).length,
    softDeletedLlmJudgments: softDeleteIds.length,
  }
}

const getExistingProjectPromptComparisonRows = async (projectId: string) => {
  return getAppDatabaseService().queryJson<ExistingProjectPromptComparisonRow>(`
    SELECT
      pp.id AS id,
      pp.prompt_id AS promptId,
      pp.origin_project_id AS originProjectId,
      pp.archived AS archived,
      pp.enabled AS enabled,
      pp.criteria_disposition AS criteriaDisposition,
      pp.criteria_section_key AS criteriaSectionKey,
      pp.criteria_section_label AS criteriaSectionLabel,
      pp.prompt_order AS "order",
      p.original_text AS originalText,
      p.prompt_heading AS promptHeading,
      p.type AS type
    FROM app.project_prompt pp
    INNER JOIN app.prompt p ON p.id = pp.prompt_id
    WHERE pp.project_id = '${escapeSqlString(projectId)}'
  `)
}

const upsertProjectPromptTx = async (
  tx: AppTx,
  params: {
    changedPromptConfigFields?: PromptConfigReviewServingField[]
    projectId: string
    promptId: string
    order: number
    archived: boolean
    enabled: boolean
    originProjectId: string | null
    criteriaDisposition: ProjectPromptCriteriaDisposition | null
    criteriaSectionKey: string | null
    criteriaSectionLabel: string | null
  },
) => {
  const hasCriteriaMetadata =
    params.criteriaDisposition !== null || params.criteriaSectionKey !== null || params.criteriaSectionLabel !== null
  const criteriaUpdateParts = hasCriteriaMetadata
    ? [
        'criteria_disposition = EXCLUDED.criteria_disposition',
        'criteria_section_key = EXCLUDED.criteria_section_key',
        'criteria_section_label = EXCLUDED.criteria_section_label',
      ]
    : []
  const updateParts = [
    'prompt_order = EXCLUDED.prompt_order',
    'archived = EXCLUDED.archived',
    'enabled = EXCLUDED.enabled',
    ...criteriaUpdateParts,
    'updated_at = now()',
  ]

  await tx.run(`
    INSERT INTO app.project_prompt (
      id,
      project_id,
      prompt_id,
      prompt_order,
      archived,
      enabled,
      origin_project_id,
      criteria_disposition,
      criteria_section_key,
      criteria_section_label
    )
    VALUES (
      '${escapeSqlString(crypto.randomUUID())}',
      '${escapeSqlString(params.projectId)}',
      '${escapeSqlString(params.promptId)}',
      ${params.order},
      ${params.archived ? 'TRUE' : 'FALSE'},
      ${params.enabled ? 'TRUE' : 'FALSE'},
      ${getSqlLiteral(params.originProjectId)},
      ${getSqlLiteral(params.criteriaDisposition)},
      ${getSqlLiteral(params.criteriaSectionKey)},
      ${getSqlLiteral(params.criteriaSectionLabel)}
    )
    ON CONFLICT(project_id, prompt_id) DO UPDATE SET
      ${updateParts.join(',\n      ')}
  `)

  await appendPromptConfigReviewServingDelta(tx, {
    changedPromptConfigFields: params.changedPromptConfigFields ?? ['archived', 'enabled', 'promptOrder'],
    projectId: params.projectId,
    promptId: params.promptId,
    sourceMutationKey: `projectPromptUpsert|${params.projectId}|${params.promptId}|${params.order}|${params.archived}|${params.enabled}`,
    sourceOperation: 'upsert',
  })
}

export const projectsRoutes = new Elysia()
  .use(withErrorHandler())
  .use(projectsRoutesGetArticlesReviews)
  .use(projectsRoutesGetArticlesReviewsCount)
  .use(projectsRoutesGetArticlesReviewsBoth)
  .use(projectsRoutesGetArticlesReviewsHuman)
  .use(projectsRoutesGetArticlesReviewsUnassessed)
  .use(projectsRoutesGetArticlesReviewsFilters)
  .use(projectsRoutesGetArticlesReviewsHumanFilters)
  .use(projectsRoutesGetPromptPreview)
  .use(projectsRoutesPostArticleReviewDetails)
  .use(projectsRoutesPostDeleteArchived)
  .use(projectsRoutesGetReviewsWarnings)
  .use(
    new Elysia().get('/api/projects-without-jobs', async () => {
      const rows = await getAppDatabaseService().queryJson<{id: string; name: string; description: string | null}>(`
        SELECT p.id AS id, p.name AS name, p.description AS description
        FROM app.project p
        LEFT JOIN app.judgment_job jj ON jj.project_id = p.id
        WHERE jj.id IS NULL
          AND p.delete_pending_at IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM app.archived_project_delete_tombstone tombstone
            WHERE tombstone.project_id = p.id
              AND tombstone.completed_at IS NULL
          )
        ORDER BY p.created_at DESC
      `)

      return {data: rows}
    }),
  )
  .get('/api/projects', async () => {
    const projectsWithModelName = await getAppDatabaseService()
      .queryJson<{
        id: string
        name: string
        description: string | null
        modelId: string
        useTitle: boolean
        useAbstract: boolean
        useFulltext: boolean
        useFulltextNoImages: boolean
        humanJudgmentMode: 'prompt' | 'summary' | null
        dateFrom: unknown
        dateTo: unknown
        archived: boolean
        createdAt: unknown
        updatedAt: unknown
        modelMetadataJson: unknown
        modelName: string | null
        modelProvider: string | null
        modelVersion: string | null
      }>(
        `
      SELECT
        p.id AS id,
        p.name AS name,
        p.description AS description,
        p.model_id AS modelId,
        p.use_title AS useTitle,
        p.use_abstract AS useAbstract,
        p.use_fulltext AS useFulltext,
        p.use_fulltext_no_images AS useFulltextNoImages,
        p.human_judgment_mode AS humanJudgmentMode,
        p.date_from AS dateFrom,
        p.date_to AS dateTo,
        p.archived AS archived,
        p.created_at AS createdAt,
        p.updated_at AS updatedAt,
        TO_JSON(m.metadata_json) AS modelMetadataJson,
        COALESCE(m.display_name, m.name, m.remote_model_id) AS modelName,
        pc.provider_kind AS modelProvider,
        m.variant AS modelVersion
      FROM app.project p
      LEFT JOIN app.model m ON p.model_id = m.id
      LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
      WHERE p.archived = FALSE
        AND p.delete_pending_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM app.archived_project_delete_tombstone tombstone
          WHERE tombstone.project_id = p.id
            AND tombstone.completed_at IS NULL
        )
      ORDER BY p.name ASC
    `,
      )
      .then((rows) => {
        return rows.map((row) => {
          const {modelMetadataJson: _modelMetadataJson, ...projectRow} = row

          return {
            ...projectRow,
            dateFrom: getDateValue(projectRow.dateFrom),
            dateTo: getDateValue(projectRow.dateTo),
            createdAt: getDateValue(projectRow.createdAt),
            modelName: getProjectModelLabel({
              metadataJson: row.modelMetadataJson,
              modelName: projectRow.modelName,
              provider: row.modelProvider,
              version: row.modelVersion,
            }),
            updatedAt: getDateValue(projectRow.updatedAt),
          }
        })
      })

    return {data: projectsWithModelName}
  })
  .get('/api/projects/archived', async () => {
    const projectsWithModelName = await getAppDatabaseService()
      .queryJson<{
        id: string
        name: string
        description: string | null
        modelId: string
        useTitle: boolean
        useAbstract: boolean
        useFulltext: boolean
        useFulltextNoImages: boolean
        humanJudgmentMode: 'prompt' | 'summary' | null
        dateFrom: unknown
        dateTo: unknown
        archived: boolean
        createdAt: unknown
        updatedAt: unknown
        modelMetadataJson: unknown
        modelName: string | null
        modelProvider: string | null
        modelVersion: string | null
      }>(
        `
      SELECT
        p.id AS id,
        p.name AS name,
        p.description AS description,
        p.model_id AS modelId,
        p.use_title AS useTitle,
        p.use_abstract AS useAbstract,
        p.use_fulltext AS useFulltext,
        p.use_fulltext_no_images AS useFulltextNoImages,
        p.human_judgment_mode AS humanJudgmentMode,
        p.date_from AS dateFrom,
        p.date_to AS dateTo,
        p.archived AS archived,
        p.created_at AS createdAt,
        p.updated_at AS updatedAt,
        TO_JSON(m.metadata_json) AS modelMetadataJson,
        COALESCE(m.display_name, m.name, m.remote_model_id) AS modelName,
        pc.provider_kind AS modelProvider,
        m.variant AS modelVersion
      FROM app.project p
      LEFT JOIN app.model m ON p.model_id = m.id
      LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
      WHERE p.archived = TRUE
        AND p.delete_pending_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM app.archived_project_delete_tombstone tombstone
          WHERE tombstone.project_id = p.id
            AND tombstone.completed_at IS NULL
        )
      ORDER BY p.created_at DESC
    `,
      )
      .then((rows) => {
        return rows.map((row) => {
          const {modelMetadataJson: _modelMetadataJson, ...projectRow} = row

          return {
            ...projectRow,
            dateFrom: getDateValue(projectRow.dateFrom),
            dateTo: getDateValue(projectRow.dateTo),
            createdAt: getDateValue(projectRow.createdAt),
            modelName: getProjectModelLabel({
              metadataJson: row.modelMetadataJson,
              modelName: projectRow.modelName,
              provider: row.modelProvider,
              version: row.modelVersion,
            }),
            updatedAt: getDateValue(projectRow.updatedAt),
          }
        })
      })

    return {data: projectsWithModelName}
  })
  .get('/api/projects/:id/access', async ({params}) => {
    const project = await getProjectAccess(params.id)

    if (!project) {
      throw new Error('Project not found')
    }

    return {data: project}
  })
  .get('/api/projects/:id', async ({params}) => {
    await assertProjectIsActive(params.id)

    const [project] = await getAppDatabaseService()
      .queryJson<{
        id: string
        name: string
        description: string | null
        modelId: string
        useTitle: boolean
        useAbstract: boolean
        useFulltext: boolean
        useFulltextNoImages: boolean
        humanJudgmentMode: 'prompt' | 'summary' | null
        dateFrom: unknown
        dateTo: unknown
        archived: boolean
        createdAt: unknown
        updatedAt: unknown
      }>(
        `
      SELECT
        id,
        name,
        description,
        model_id AS modelId,
        use_title AS useTitle,
        use_abstract AS useAbstract,
        use_fulltext AS useFulltext,
        use_fulltext_no_images AS useFulltextNoImages,
        human_judgment_mode AS humanJudgmentMode,
        date_from AS dateFrom,
        date_to AS dateTo,
        archived,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM app.project
      WHERE id = '${escapeSqlString(params.id)}'
        AND delete_pending_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM app.archived_project_delete_tombstone tombstone
          WHERE tombstone.project_id = app.project.id
            AND tombstone.completed_at IS NULL
        )
      LIMIT 1
    `,
      )
      .then((rows) => {
        return rows.map((row) => {
          return {
            ...row,
            dateFrom: getDateValue(row.dateFrom),
            dateTo: getDateValue(row.dateTo),
            createdAt: getDateValue(row.createdAt),
            updatedAt: getDateValue(row.updatedAt),
          }
        })
      })

    if (!project) {
      throw new Error('Project not found')
    }

    const [projectPromptsList, importablePrompts, existingJob, projectModelRows, linkedImportRoutes] =
      await Promise.all([
        getAppDatabaseService().queryJson<{
          id: string
          originalText: string
          transformedText: string | null
          promptHeading: string | null
          order: number | null
          archived: boolean
          promptArchived: boolean
          type: string | null
          enabled: boolean
          originProjectId: string | null
          linkedToProject: boolean
          contentHash: string | null
          createdAt: unknown
        }>(`
        SELECT
          p.id AS id,
          p.original_text AS originalText,
          p.transformed_text AS transformedText,
          p.prompt_heading AS promptHeading,
          pp.prompt_order AS "order",
          pp.archived AS archived,
          p.archived AS promptArchived,
          p.type AS type,
          pp.enabled AS enabled,
          pp.origin_project_id AS originProjectId,
          TRUE AS linkedToProject,
          p.content_hash AS contentHash,
          p.created_at AS createdAt
        FROM app.project_prompt pp
        INNER JOIN app.prompt p ON pp.prompt_id = p.id
        WHERE pp.project_id = '${escapeSqlString(params.id)}'
        ORDER BY pp.prompt_order ASC NULLS LAST
      `),
        getAppDatabaseService().queryJson<{
          id: string
          originalText: string
          transformedText: string | null
          promptHeading: string | null
          order: number | null
          archived: boolean
          promptArchived: boolean
          type: string | null
          enabled: boolean
          originProjectId: string | null
          linkedToProject: boolean
          contentHash: string | null
          createdAt: unknown
        }>(`
        SELECT
          p.id AS id,
          p.original_text AS originalText,
          p.transformed_text AS transformedText,
          p.prompt_heading AS promptHeading,
          NULL AS "order",
          FALSE AS archived,
          p.archived AS promptArchived,
          p.type AS type,
          FALSE AS enabled,
          NULL AS originProjectId,
          FALSE AS linkedToProject,
          p.content_hash AS contentHash,
          p.created_at AS createdAt
        FROM app.prompt p
        LEFT JOIN app.project_prompt pp ON pp.project_id = '${escapeSqlString(params.id)}' AND pp.prompt_id = p.id
        WHERE pp.id IS NULL
          AND p.archived = FALSE
          AND NOT EXISTS (
            SELECT 1
            FROM app.project_prompt linked_pp
            INNER JOIN app.prompt linked_prompt ON linked_prompt.id = linked_pp.prompt_id
            WHERE linked_pp.project_id = '${escapeSqlString(params.id)}'
              AND linked_prompt.original_text = p.original_text
              AND COALESCE(linked_prompt.transformed_text, '') = COALESCE(p.transformed_text, '')
              AND COALESCE(linked_prompt.prompt_heading, '') = COALESCE(p.prompt_heading, '')
              AND COALESCE(linked_prompt.type, '') = COALESCE(p.type, '')
          )
      `),
        getAppDatabaseService().queryJson<{id: string}>(`
        SELECT id
        FROM app.judgment_job
        WHERE project_id = '${escapeSqlString(params.id)}'
        LIMIT 1
      `),
        getAppDatabaseService().queryJson<{
          id: string
          name: string
          provider: string | null
          modelName: string | null
          modelMetadataJson: unknown
          baseURL: string | null
          version: string | null
        }>(`
        SELECT
          m.id AS id,
          COALESCE(m.display_name, m.name, m.remote_model_id) AS name,
          pc.provider_kind AS provider,
          m.remote_model_id AS modelName,
          TO_JSON(m.metadata_json) AS modelMetadataJson,
          pc.base_url AS baseURL,
          m.variant AS version
        FROM app.model m
        LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
        WHERE m.id = '${escapeSqlString(project.modelId)}'
        LIMIT 1
      `),
        getAppDatabaseService().queryJson<{route: string; name: string | null}>(`
        SELECT ir.route AS route, ir.name AS name
        FROM app.project_import_route pir
        INNER JOIN app.import_route ir ON pir.import_route_id = ir.id
        WHERE pir.project_id = '${escapeSqlString(params.id)}'
      `),
      ])

    const promptsCombined = [...projectPromptsList, ...importablePrompts].map((row) => {
      return {...row, createdAt: getDateValue(row.createdAt)}
    })

    const hasJudgedArticles = existingJob.length > 0
    const [projectModelRow] = projectModelRows
    const projectModel = projectModelRow
      ? {
          ...(({modelMetadataJson: _modelMetadataJson, ...modelRow}) => {
            return modelRow
          })(projectModelRow),
          name: getProjectModelLabel({
            metadataJson: projectModelRow.modelMetadataJson,
            modelName: projectModelRow.name,
            provider: projectModelRow.provider,
            version: projectModelRow.version,
          }),
        }
      : undefined

    const importRoutes = linkedImportRoutes.map((r) => {
      return r.route
    })

    const importRouteNamesByRoute = linkedImportRoutes.reduce<Record<string, string | null>>((acc, row) => {
      acc[row.route] = row.name ?? null
      return acc
    }, {})

    return {
      data: {
        project,
        prompts: promptsCombined,
        hasJudgedArticles,
        model: projectModel ?? null,
        importRoutes,
        importRouteNamesByRoute,
      },
    }
  })
  .post(
    '/api/projects',
    async ({body}) => {
      const dateFrom = parseOptionalDate(body.dateFrom)
      const dateTo = parseOptionalDate(body.dateTo)
      if (dateFrom && dateTo && dateFrom > dateTo) {
        throw new Error('date_from must be on or before date_to')
      }

      await assertSelectableProviderModelId(getAppDatabaseService(), {
        errorMessage: 'Selected model does not exist or is disabled',
        modelId: body.modelId,
      })

      // Validate mutual exclusivity of useFulltext and useFulltextNoImages
      if (body.useFulltext && body.useFulltextNoImages) {
        throw new Error('Cannot enable both "Use Full Text" and "Use Full Text (No Images)" at the same time')
      }

      const newProject = (await getAppDatabaseService().transaction(async (tx) => {
        const newProjectId = crypto.randomUUID()
        const [createdProject] = await tx.queryJson<{
          id: string
          name: string
          description: string | null
          modelId: string
          useTitle: boolean
          useAbstract: boolean
          useFulltext: boolean
          useFulltextNoImages: boolean
          dateFrom: unknown
          dateTo: unknown
          archived: boolean
          createdAt: unknown
          updatedAt: unknown
        }>(`
          INSERT INTO app.project (
            id,
            name,
            description,
            model_id,
            use_title,
            use_abstract,
            use_fulltext,
            use_fulltext_no_images,
            date_from,
            date_to
          )
          VALUES (
            '${escapeSqlString(newProjectId)}',
            ${getSqlLiteral(body.name)},
            ${getSqlLiteral(body.description || null)},
            '${escapeSqlString(body.modelId)}',
            ${(body.useTitle ?? true) ? 'TRUE' : 'FALSE'},
            ${(body.useAbstract ?? true) ? 'TRUE' : 'FALSE'},
            ${(body.useFulltext ?? false) ? 'TRUE' : 'FALSE'},
            ${(body.useFulltextNoImages ?? false) ? 'TRUE' : 'FALSE'},
            ${dateFrom ? getTimestampLiteral(dateFrom) : 'NULL'},
            ${dateTo ? getTimestampLiteral(dateTo) : 'NULL'}
          )
          RETURNING
            id,
            name,
            description,
            model_id AS modelId,
            use_title AS useTitle,
            use_abstract AS useAbstract,
            use_fulltext AS useFulltext,
            use_fulltext_no_images AS useFulltextNoImages,
            date_from AS dateFrom,
            date_to AS dateTo,
            archived,
            created_at AS createdAt,
            updated_at AS updatedAt
        `)

        if (!createdProject) {
          throw new Error('Failed to create project')
        }

        if (body.prompts && body.prompts.length > 0) {
          const submittedPrompts = (
            body.prompts as Array<string | {content: string; promptHeading?: string; type?: string; order: number}>
          ).filter((prompt) => {
            return typeof prompt === 'string' ? prompt.trim() !== '' : (prompt.content ?? '').trim() !== ''
          })

          for (let index = 0; index < submittedPrompts.length; index++) {
            const prompt = submittedPrompts[index] as
              | string
              | {content: string; promptHeading?: string; type?: string; order: number}
            const content = typeof prompt === 'string' ? prompt : prompt.content
            const heading = typeof prompt === 'object' ? prompt.promptHeading || null : null
            const typeVal = typeof prompt === 'object' ? prompt.type || null : null
            const orderVal = typeof prompt === 'object' && prompt.order !== undefined ? prompt.order : index
            const promptId = await getOrCreateImmutablePromptTx(tx, {
              originalText: content,
              transformedText: null,
              promptHeading: heading,
              type: typeVal,
              archived: false,
            })

            if (!promptId) {
              throw new Error('Prompt not found after insert')
            }

            await upsertProjectPromptTx(tx, {
              changedPromptConfigFields: [...immutablePromptIdentityReviewServingFields, 'promptOrder', 'enabled'],
              projectId: createdProject.id,
              promptId,
              order: orderVal,
              archived: false,
              enabled: true,
              originProjectId: null,
            })
          }
        }

        if (body.existingPromptIds && body.existingPromptIds.length > 0) {
          for (const existing of body.existingPromptIds) {
            const [existingPrompt] = await tx.queryJson<{id: string}>(`
              SELECT id
              FROM app.prompt
              WHERE id = '${escapeSqlString(existing.originalId)}'
              LIMIT 1
            `)

            if (!existingPrompt) {
              throw new Error(`Existing prompt not found: ${existing.originalId}`)
            }

            await upsertProjectPromptTx(tx, {
              changedPromptConfigFields: ['promptOrder', 'enabled'],
              projectId: createdProject.id,
              promptId: existing.originalId,
              order: existing.order,
              archived: false,
              enabled: true,
              originProjectId: null,
            })
          }
        }

        const selectedRoutes = Array.from(
          new Set(
            (body.importRoutes ?? []).filter((route) => {
              return typeof route === 'string' && route.trim() !== ''
            }),
          ),
        )

        if (selectedRoutes.length > 0) {
          const routeRows = await tx.queryJson<{id: string; route: string}>(`
            SELECT id, route
            FROM app.import_route
            WHERE route IN (${getQuotedStringList(selectedRoutes).join(', ')})
          `)

          if (routeRows.length !== selectedRoutes.length) {
            throw new Error('One or more selected import routes are invalid')
          }

          await tx.run(`
            INSERT INTO app.project_import_route (id, project_id, import_route_id)
            VALUES ${routeRows
              .map((row) => {
                return `(${getQuotedStringList([crypto.randomUUID(), createdProject.id, row.id]).join(', ')})`
              })
              .join(', ')}
            ON CONFLICT(project_id, import_route_id) DO NOTHING
          `)
        }

        await appendProjectReviewConfigDeltaIfNeeded(tx, {
          changedReviewConfigFields: [
            'modelId',
            'modelExecutionIdentity',
            'useTitle',
            'useAbstract',
            'useFulltext',
            'useFulltextNoImages',
            ...(body.prompts?.length || body.existingPromptIds?.length ? (['promptMembership'] as const) : []),
            ...(selectedRoutes.length > 0 ? (['importRoutes'] as const) : []),
          ],
          projectId: createdProject.id,
          sourceMutationKey: `projectCreate|${createdProject.id}`,
          sourceOperation: 'insert',
        })

        const dirtyProjects = await getProjectMartDirtyRefreshStateService().getDirtyProjectsForProjectIds(tx, [
          createdProject.id,
        ])

        await getProjectMartDirtyRefreshStateService().markProjectsDirtyAtomically({
          projects: dirtyProjects,
          reason: 'ProjectsRoutes.post',
          runner: tx,
        })

        return getProjectValue(createdProject)
      })) as ReturnType<typeof getProjectValue>

      return {data: newProject}
    },
    {
      body: t.Object({
        name: t.String(),
        description: t.Optional(t.String()),
        modelId: t.String(),
        dateFrom: t.Optional(t.String()),
        dateTo: t.Optional(t.String()),
        useTitle: t.Optional(t.Boolean()),
        useAbstract: t.Optional(t.Boolean()),
        useFulltext: t.Optional(t.Boolean()),
        useFulltextNoImages: t.Optional(t.Boolean()),
        importRoutes: t.Optional(t.Array(t.String())),
        prompts: t.Optional(
          t.Union([
            t.Array(t.String()),
            t.Array(
              t.Object({
                content: t.String(),
                promptHeading: t.Optional(t.String()),
                type: t.Optional(t.String()),
                order: t.Number(),
              }),
            ),
          ]),
        ),
        existingPromptIds: t.Optional(t.Array(t.Object({originalId: t.String(), order: t.Number()}))),
      }),
    },
  )
  .patch(
    '/api/projects/:id',
    async ({params, body}) => {
      await assertProjectIsActive(params.id)

      const updateParts = [
        `updated_at = current_timestamp`,
        body.name !== undefined ? `name = ${getSqlLiteral(body.name)}` : null,
        body.description !== undefined ? `description = ${getSqlLiteral(body.description)}` : null,
      ].filter((part): part is string => {
        return part !== null
      })

      const updatedProject = (await getAppDatabaseService().transaction(async (tx) => {
        return updateProjectTx(tx, {projectId: params.id, updateParts})
      })) as ProjectRow | null

      if (!updatedProject) {
        throw new Error('Project not found')
      }

      return {data: getProjectValue(updatedProject)}
    },
    {body: t.Object({name: t.Optional(t.String()), description: t.Optional(t.Union([t.String(), t.Null()]))})},
  )
  .patch(
    '/api/projects/:id/edit',
    async ({params, body}) => {
      await assertProjectIsActive(params.id)

      const [job] = await getAppDatabaseService().queryJson<ProjectEditJudgmentJob>(`
        SELECT
          id,
          status,
          storage_state AS storageState,
          last_import_started_at AS lastImportStartedAt,
          last_import_completed_at AS lastImportCompletedAt
        FROM app.judgment_job
        WHERE project_id = '${escapeSqlString(params.id)}'
        LIMIT 1
      `)
      const hasExistingJob = Boolean(job)

      const parsedDateFrom = body.dateFrom === undefined ? undefined : parseOptionalDate(body.dateFrom)
      const parsedDateTo = body.dateTo === undefined ? undefined : parseOptionalDate(body.dateTo)
      if (parsedDateFrom && parsedDateTo && parsedDateFrom > parsedDateTo) {
        throw new Error('date_from must be on or before date_to')
      }

      const [currentProject] = await getAppDatabaseService().queryJson<ProjectEditCurrentProject>(`
        SELECT
          id,
          model_id AS modelId,
          human_judgment_mode AS humanJudgmentMode,
          use_title AS useTitle,
          use_abstract AS useAbstract,
          use_fulltext AS useFulltext,
          use_fulltext_no_images AS useFulltextNoImages,
          date_from AS dateFrom,
          date_to AS dateTo
        FROM app.project
        WHERE id = '${escapeSqlString(params.id)}'
          AND delete_pending_at IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM app.archived_project_delete_tombstone tombstone
            WHERE tombstone.project_id = app.project.id
              AND tombstone.completed_at IS NULL
          )
        LIMIT 1
      `)

      if (!currentProject) {
        throw new Error('Project not found')
      }

      const [currentImportRoutes, existingPromptComparisonRows] = await Promise.all([
        hasExistingJob && body.importRoutes !== undefined
          ? getCurrentProjectImportRoutes(params.id)
          : Promise.resolve([]),
        hasExistingJob && body.prompts !== undefined
          ? getExistingProjectPromptComparisonRows(params.id)
          : Promise.resolve([]),
      ])
      const changedProtectedFields = hasExistingJob
        ? getChangedProtectedProjectEditFields({
            body,
            currentImportRoutes,
            currentProject,
            parsedDateFrom,
            parsedDateTo,
          })
        : []

      if (changedProtectedFields.length > 0) {
        throw new HttpError(
          409,
          `Protected project fields cannot be changed after a judgment job exists: ${changedProtectedFields.join(', ')}`,
        )
      }

      const hasPromptChanges = hasExistingJob
        ? getHasProjectPromptEditChanges({
            existingPrompts: existingPromptComparisonRows,
            submittedPrompts: body.prompts as ProjectEditPromptPayload[] | undefined,
          })
        : body.prompts !== undefined

      if (job && hasPromptChanges && !(await canEditPromptsWithJudgmentJob(getAppDatabaseService(), job))) {
        throw new HttpError(409, 'Pause or drain the judgment job before editing prompts.')
      }

      const hasModelIdUpdate = body.modelId !== undefined && body.modelId !== currentProject.modelId
      const hasImportRouteChanges =
        body.importRoutes !== undefined && (!hasExistingJob || changedProtectedFields.includes('importRoutes'))
      const changedReviewConfigFields = getChangedReviewConfigFields({
        body,
        currentProject,
        hasImportRouteChanges,
        hasModelIdUpdate,
        hasPromptChanges,
      })

      const runEditTransaction = () => {
        return getAppDatabaseService().transaction(async (tx) => {
          let promptCleanupSummary: ProjectPromptCleanupSummary | undefined

          if (hasModelIdUpdate) {
            await assertSelectableProviderModelId(tx, {
              errorMessage: 'Selected model does not exist or is disabled',
              modelId: body.modelId,
            })
          }

          const finalUseFulltext = body.useFulltext ?? currentProject.useFulltext
          const finalUseFulltextNoImages = body.useFulltextNoImages ?? currentProject.useFulltextNoImages
          if (finalUseFulltext && finalUseFulltextNoImages) {
            throw new Error('Cannot enable both "Use Full Text" and "Use Full Text (No Images)" at the same time')
          }

          const updateParts = [
            `updated_at = current_timestamp`,
            body.name !== undefined ? `name = ${getSqlLiteral(body.name)}` : null,
            body.description !== undefined ? `description = ${getSqlLiteral(body.description)}` : null,
            !hasExistingJob && parsedDateFrom !== undefined ? `date_from = ${getSqlLiteral(parsedDateFrom)}` : null,
            !hasExistingJob && parsedDateTo !== undefined ? `date_to = ${getSqlLiteral(parsedDateTo)}` : null,
            !hasExistingJob && hasModelIdUpdate ? `model_id = ${getSqlLiteral(body.modelId)}` : null,
            !hasExistingJob && body.humanJudgmentMode !== undefined
              ? `human_judgment_mode = ${getSqlLiteral(body.humanJudgmentMode)}`
              : null,
            !hasExistingJob && body.useTitle !== undefined ? `use_title = ${body.useTitle ? 'TRUE' : 'FALSE'}` : null,
            !hasExistingJob && body.useAbstract !== undefined
              ? `use_abstract = ${body.useAbstract ? 'TRUE' : 'FALSE'}`
              : null,
            !hasExistingJob && body.useFulltext !== undefined
              ? `use_fulltext = ${body.useFulltext ? 'TRUE' : 'FALSE'}`
              : null,
            !hasExistingJob && body.useFulltextNoImages !== undefined
              ? `use_fulltext_no_images = ${body.useFulltextNoImages ? 'TRUE' : 'FALSE'}`
              : null,
          ].filter((part): part is string => {
            return part !== null
          })

          const updatedProject = await updateProjectTx(tx, {projectId: params.id, updateParts})

          if (!updatedProject) {
            throw new Error('Project not found')
          }

          if (body.prompts !== undefined && (!hasExistingJob || hasPromptChanges)) {
            const submitted = body.prompts.filter((prompt) => {
              return (prompt.originalText ?? '').trim() !== ''
            })
            const existing = await tx.queryJson<ExistingProjectPromptAssociation>(`
            SELECT
              id,
              prompt_id AS promptId,
              origin_project_id AS originProjectId,
              archived,
              enabled,
              criteria_disposition AS criteriaDisposition,
              criteria_section_key AS criteriaSectionKey,
              criteria_section_label AS criteriaSectionLabel
            FROM app.project_prompt
            WHERE project_id = '${escapeSqlString(params.id)}'
          `)

            const existingPromptIds = new Set(
              existing.map((prompt) => {
                return prompt.promptId
              }),
            )
            const resolvedPromptEdits: ResolvedProjectPromptEdit[] = []

            for (const prompt of submitted as ProjectEditPromptPayload[]) {
              const order = prompt.order
              const archived = typeof prompt.archived === 'boolean' ? prompt.archived : undefined
              const enabled = typeof prompt.enabled === 'boolean' ? prompt.enabled : undefined

              if (prompt.originalId) {
                const isAlreadyAssociated = existingPromptIds.has(prompt.originalId)
                if (!isAlreadyAssociated && enabled !== true) {
                  continue
                }

                const [existingPrompt] = await tx.queryJson<{
                  id: string
                  originalText: string
                  promptHeading: string | null
                  type: string | null
                  promptArchived: boolean
                }>(`
                SELECT
                  id,
                  original_text AS originalText,
                  prompt_heading AS promptHeading,
                  type,
                  archived AS promptArchived
                FROM app.prompt
                WHERE id = '${escapeSqlString(prompt.originalId)}'
                LIMIT 1
              `)

                if (!existingPrompt) {
                  throw new Error('Prompt not found')
                }

                const existingPromptHeading = getPromptMetadataValue(existingPrompt.promptHeading) ?? null
                const existingPromptType = getPromptMetadataValue(existingPrompt.type) ?? null
                const promptHeading = getPromptMetadataValue(prompt.promptHeading)
                const promptType = getPromptMetadataValue(prompt.type)
                const targetPromptHeading = promptHeading === undefined ? existingPromptHeading : promptHeading
                const targetPromptType = promptType === undefined ? existingPromptType : promptType
                const textChanged = existingPrompt.originalText !== prompt.originalText
                const metaChanged =
                  targetPromptHeading !== existingPromptHeading || targetPromptType !== existingPromptType

                const targetPromptId =
                  textChanged || metaChanged
                    ? await getOrCreateImmutablePromptTx(tx, {
                        originalText: prompt.originalText,
                        transformedText: null,
                        promptHeading: targetPromptHeading,
                        type: targetPromptType,
                        archived: existingPrompt.promptArchived,
                        unarchiveExisting: false,
                      })
                    : prompt.originalId

                if (!targetPromptId) {
                  throw new Error('Prompt not found after insert')
                }

                const currentAssociation = existing.find((entry) => {
                  return entry.promptId === prompt.originalId
                })

                resolvedPromptEdits.push({
                  archived,
                  changedPromptConfigFields: [
                    ...(textChanged ? (['promptText'] as const) : []),
                    ...(targetPromptHeading !== existingPromptHeading ? (['promptHeading'] as const) : []),
                    ...(targetPromptType !== existingPromptType ? (['promptType'] as const) : []),
                    'promptOrder',
                    ...(typeof archived === 'boolean' && archived !== currentAssociation?.archived
                      ? (['archived'] as const)
                      : []),
                    ...(typeof enabled === 'boolean' && enabled !== currentAssociation?.enabled
                      ? (['enabled'] as const)
                      : []),
                  ],
                  currentAssociation,
                  enabled,
                  order,
                  originalId: prompt.originalId,
                  shouldDeleteOriginalAssociation: textChanged || metaChanged,
                  targetPromptId,
                })
              } else {
                const targetPromptId = await getOrCreateImmutablePromptTx(tx, {
                  originalText: prompt.originalText,
                  transformedText: null,
                  promptHeading: getPromptMetadataValue(prompt.promptHeading) ?? null,
                  type: getPromptMetadataValue(prompt.type) ?? null,
                  archived: false,
                  unarchiveExisting: false,
                })

                if (!targetPromptId) {
                  throw new Error('Prompt not found after insert')
                }

                resolvedPromptEdits.push({
                  archived,
                  changedPromptConfigFields: [...immutablePromptIdentityReviewServingFields, 'promptOrder', 'enabled'],
                  currentAssociation: undefined,
                  enabled,
                  order,
                  originalId: undefined,
                  shouldDeleteOriginalAssociation: false,
                  targetPromptId,
                })
              }
            }

            const duplicateTargetPromptIds = getDuplicateTargetPromptIds(
              resolvedPromptEdits.map((promptEdit) => {
                return promptEdit.targetPromptId
              }),
            )

            if (duplicateTargetPromptIds.length > 0) {
              throw new HttpError(
                400,
                'Project prompts must resolve to unique prompt content. Remove duplicate prompt text, heading, and type before saving.',
              )
            }

            const receivedOriginalIds = new Set(
              resolvedPromptEdits
                .map((promptEdit) => {
                  return promptEdit.originalId
                })
                .filter((id): id is string => {
                  return typeof id === 'string'
                }),
            )
            const finalTargetPromptIds = new Set(
              resolvedPromptEdits.map((promptEdit) => {
                return promptEdit.targetPromptId
              }),
            )
            const toDeleteAssoc = existing.filter((entry) => {
              return !receivedOriginalIds.has(entry.promptId) && !finalTargetPromptIds.has(entry.promptId)
            })
            const originalPromptIdsToDelete = getUniqueSortedStrings(
              resolvedPromptEdits
                .filter((promptEdit) => {
                  return (
                    promptEdit.shouldDeleteOriginalAssociation
                    && typeof promptEdit.originalId === 'string'
                    && !finalTargetPromptIds.has(promptEdit.originalId)
                  )
                })
                .map((promptEdit) => {
                  return promptEdit.originalId
                })
                .filter((id): id is string => {
                  return typeof id === 'string'
                }),
            )
            const promptIdsToDelete = getUniqueSortedStrings([
              ...toDeleteAssoc.map((entry) => {
                return entry.promptId
              }),
              ...originalPromptIdsToDelete,
            ])
            const changedPromptLinks = getChangedProjectPromptLinks({
              removedAssociations: toDeleteAssoc,
              resolvedPromptEdits,
            })

            if (promptIdsToDelete.length > 0) {
              await tx.run(`
              DELETE FROM app.project_prompt
              WHERE project_id = '${escapeSqlString(params.id)}'
                AND prompt_id IN (${getQuotedStringList(promptIdsToDelete).join(', ')})
            `)
            }

            for (const promptEdit of resolvedPromptEdits) {
              if (promptEdit.currentAssociation) {
                await upsertProjectPromptTx(tx, {
                  changedPromptConfigFields: promptEdit.changedPromptConfigFields,
                  projectId: params.id,
                  promptId: promptEdit.targetPromptId,
                  order: promptEdit.order,
                  archived: promptEdit.archived ?? promptEdit.currentAssociation.archived,
                  enabled: promptEdit.enabled ?? promptEdit.currentAssociation.enabled,
                  originProjectId: null,
                  criteriaDisposition: promptEdit.currentAssociation.criteriaDisposition,
                  criteriaSectionKey: promptEdit.currentAssociation.criteriaSectionKey,
                  criteriaSectionLabel: promptEdit.currentAssociation.criteriaSectionLabel,
                })
              } else {
                await upsertProjectPromptTx(tx, {
                  changedPromptConfigFields: promptEdit.changedPromptConfigFields,
                  projectId: params.id,
                  promptId: promptEdit.targetPromptId,
                  order: promptEdit.order,
                  archived: promptEdit.archived ?? false,
                  enabled: promptEdit.enabled ?? true,
                  originProjectId: null,
                  criteriaDisposition: null,
                  criteriaSectionKey: null,
                  criteriaSectionLabel: null,
                })
              }
            }

            promptCleanupSummary = {
              changedPromptLinks,
              deletedHumanPromptAnswers: await deleteProjectHumanPromptAnswersForChangedPromptLinksTx(tx, {
                changedPromptLinks,
                projectId: params.id,
              }),
              ...(await softDeleteProjectPromptLlmJudgmentsTx(tx, {changedPromptLinks, projectId: params.id})),
            }
            logProjectPromptCleanupSummary({projectId: params.id, summary: promptCleanupSummary})
          }

          if (promptCleanupSummary) {
            await markComparisonServingStaleForProjectPromptEditTx(tx, params.id)
          }

          if (body.importRoutes !== undefined && !hasExistingJob) {
            const selectedRoutes = Array.from(
              new Set(
                body.importRoutes.filter((route) => {
                  return typeof route === 'string' && route.trim() !== ''
                }),
              ),
            )

            await tx.run(`
            DELETE FROM app.project_import_route
            WHERE project_id = '${escapeSqlString(params.id)}'
          `)

            if (selectedRoutes.length > 0) {
              const routeRows = await tx.queryJson<{id: string; route: string}>(`
              SELECT id, route
              FROM app.import_route
              WHERE route IN (${getQuotedStringList(selectedRoutes).join(', ')})
            `)

              if (routeRows.length !== selectedRoutes.length) {
                throw new Error('One or more selected import routes are invalid')
              }

              await tx.run(`
              INSERT INTO app.project_import_route (id, project_id, import_route_id)
              VALUES ${routeRows
                .map((route) => {
                  return `(${getQuotedStringList([crypto.randomUUID(), params.id, route.id]).join(', ')})`
                })
                .join(', ')}
              ON CONFLICT(project_id, import_route_id) DO NOTHING
            `)
            }
          }

          await appendProjectReviewConfigDeltaIfNeeded(tx, {
            changedReviewConfigFields,
            projectId: params.id,
            sourceMutationKey: `projectEdit|${params.id}|${changedReviewConfigFields.join(',')}`,
            sourceOperation: 'update',
          })

          const updatedPrompts = await tx.queryJson<{
            id: string
            originalText: string
            transformedText: string | null
            promptHeading: string | null
            order: number | null
            archived: boolean
            promptArchived: boolean
            type: string | null
            enabled: boolean
            originProjectId: string | null
            linkedToProject: boolean
          }>(`
          SELECT
            p.id AS id,
            p.original_text AS originalText,
            p.transformed_text AS transformedText,
            p.prompt_heading AS promptHeading,
            pp.prompt_order AS "order",
            pp.archived AS archived,
            p.archived AS promptArchived,
            p.type AS type,
            pp.enabled AS enabled,
            pp.origin_project_id AS originProjectId,
            TRUE AS linkedToProject
          FROM app.project_prompt pp
          INNER JOIN app.prompt p ON pp.prompt_id = p.id
          WHERE pp.project_id = '${escapeSqlString(params.id)}'
          ORDER BY pp.prompt_order ASC NULLS LAST
        `)

          const dirtyProjects = await getProjectMartDirtyRefreshStateService().getDirtyProjectsForProjectIds(tx, [
            params.id,
          ])

          await getProjectMartDirtyRefreshStateService().markProjectsDirtyAtomically({
            projects: dirtyProjects,
            reason: 'ProjectsRoutes.edit',
            runner: tx,
          })

          return promptCleanupSummary
            ? {project: getProjectValue(updatedProject), promptCleanupSummary, prompts: updatedPrompts}
            : {project: getProjectValue(updatedProject), prompts: updatedPrompts}
        })
      }

      const result = await runEditTransaction()

      return {data: result}
    },
    {
      body: t.Object({
        name: t.Optional(t.String()),
        description: t.Optional(t.Union([t.String(), t.Null()])),
        dateFrom: t.Optional(t.Union([t.String(), t.Null()])),
        dateTo: t.Optional(t.Union([t.String(), t.Null()])),
        modelId: t.Optional(t.String()),
        humanJudgmentMode: t.Optional(t.Union([t.Literal('prompt'), t.Literal('summary')])),
        useTitle: t.Optional(t.Boolean()),
        useAbstract: t.Optional(t.Boolean()),
        useFulltext: t.Optional(t.Boolean()),
        useFulltextNoImages: t.Optional(t.Boolean()),
        importRoutes: t.Optional(t.Array(t.String())),
        prompts: t.Optional(
          t.Array(
            t.Object({
              originalId: t.Optional(t.String()),
              originalText: t.String(),
              promptHeading: t.Optional(t.String()),
              type: t.Optional(t.String()),
              order: t.Number(),
              archived: t.Optional(t.Boolean()),
              enabled: t.Optional(t.Boolean()),
            }),
          ),
        ),
      }),
    },
  )
  .delete('/api/projects/:id', async ({params}) => {
    await assertProjectIsActive(params.id)

    const archivedProject = await getAppDatabaseService().transaction(async (tx) => {
      const updatedProject = await updateProjectTx(tx, {
        projectId: params.id,
        updateParts: ['archived = TRUE', 'updated_at = current_timestamp'],
      })

      if (updatedProject) {
        await tx.run(`
          UPDATE app.judgment_job
          SET status = CASE
                WHEN status IN ('completed', 'failed', 'project_removed') THEN status
                ELSE 'project_removed'
              END,
              storage_state = CASE
                WHEN storage_state IN ('drained', 'quarantined') THEN storage_state
                ELSE 'draining'
              END,
              pause_requested_at = current_timestamp,
              updated_at = current_timestamp
          WHERE project_id = '${escapeSqlString(params.id)}'
        `)
        await getProjectMartDirtyRefreshStateService().clearProjectRefreshState({projectId: params.id, runner: tx})
        await getProjectMartLargeRebuildStateService().clearLargeRebuildState({projectId: params.id, runner: tx})
      }

      return updatedProject
    })

    if (!archivedProject) {
      throw new Error('Project not found')
    }

    return {success: true}
  })
  .post('/api/projects/:id/unarchive', async ({params}) => {
    const unarchivedProject = await getAppDatabaseService().transaction(async (tx) => {
      const updatedProject = await updateProjectTx(tx, {
        projectId: params.id,
        updateParts: ['archived = FALSE', 'updated_at = current_timestamp'],
      })

      if (updatedProject) {
        const refreshStateService = getProjectMartDirtyRefreshStateService()
        const dirtyProjects = await refreshStateService.getDirtyProjectsForProjectScopeArticleIds(tx, [params.id])

        await refreshStateService.markProjectsDirtyAtomically({
          projects: dirtyProjects.length === 0 ? [{projectId: params.id}] : dirtyProjects,
          reason: 'ProjectsRoutes.unarchive',
          runner: tx,
        })
      }

      return updatedProject
    })

    if (!unarchivedProject) {
      throw new Error('Project not found')
    }

    return {success: true}
  })
  .post('/api/projects/:id/clone', async ({params}) => {
    await assertProjectIsActive(params.id)

    const [sourceProject] = await getAppDatabaseService()
      .queryJson<{
        id: string
        name: string
        description: string | null
        modelId: string
        humanJudgmentMode: 'prompt' | 'summary' | null
        useTitle: boolean
        useAbstract: boolean
        useFulltext: boolean
        useFulltextNoImages: boolean
        dateFrom: unknown
        dateTo: unknown
      }>(
        `
      SELECT
        id,
        name,
        description,
        model_id AS modelId,
        human_judgment_mode AS humanJudgmentMode,
        use_title AS useTitle,
        use_abstract AS useAbstract,
        use_fulltext AS useFulltext,
        use_fulltext_no_images AS useFulltextNoImages,
        date_from AS dateFrom,
        date_to AS dateTo
      FROM app.project
      WHERE id = '${escapeSqlString(params.id)}'
        AND delete_pending_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM app.archived_project_delete_tombstone tombstone
          WHERE tombstone.project_id = app.project.id
            AND tombstone.completed_at IS NULL
        )
      LIMIT 1
    `,
      )
      .then((rows) => {
        return rows.map((row) => {
          return {...row, dateFrom: getDateValue(row.dateFrom), dateTo: getDateValue(row.dateTo)}
        })
      })

    if (!sourceProject) {
      throw new Error('Project not found')
    }

    await assertSelectableProviderModelId(getAppDatabaseService(), {
      errorMessage: 'Source project model does not exist or is disabled',
      modelId: sourceProject.modelId,
    })

    const result = (await getAppDatabaseService().transaction(async (tx) => {
      const clonedProjectId = crypto.randomUUID()
      const [clonedProject] = await tx.queryJson<{
        id: string
        name: string
        description: string | null
        modelId: string
        humanJudgmentMode: 'prompt' | 'summary' | null
        useTitle: boolean
        useAbstract: boolean
        useFulltext: boolean
        useFulltextNoImages: boolean
        dateFrom: unknown
        dateTo: unknown
        archived: boolean
        createdAt: unknown
        updatedAt: unknown
      }>(`
        INSERT INTO app.project (
          id,
          name,
          description,
          model_id,
          human_judgment_mode,
          use_title,
          use_abstract,
          use_fulltext,
          use_fulltext_no_images,
          date_from,
          date_to,
          archived
        )
        VALUES (
          '${escapeSqlString(clonedProjectId)}',
          ${getSqlLiteral(`${sourceProject.name} - Copy`)},
          ${getSqlLiteral(sourceProject.description)},
          '${escapeSqlString(sourceProject.modelId)}',
          ${getSqlLiteral(sourceProject.humanJudgmentMode ?? 'prompt')},
          ${sourceProject.useTitle ? 'TRUE' : 'FALSE'},
          ${sourceProject.useAbstract ? 'TRUE' : 'FALSE'},
          ${sourceProject.useFulltext ? 'TRUE' : 'FALSE'},
          ${sourceProject.useFulltextNoImages ? 'TRUE' : 'FALSE'},
          ${sourceProject.dateFrom ? getTimestampLiteral(sourceProject.dateFrom) : 'NULL'},
          ${sourceProject.dateTo ? getTimestampLiteral(sourceProject.dateTo) : 'NULL'},
          FALSE
        )
        RETURNING
          id,
          name,
          description,
          model_id AS modelId,
          human_judgment_mode AS humanJudgmentMode,
          use_title AS useTitle,
          use_abstract AS useAbstract,
          use_fulltext AS useFulltext,
          use_fulltext_no_images AS useFulltextNoImages,
          date_from AS dateFrom,
          date_to AS dateTo,
          archived,
          created_at AS createdAt,
          updated_at AS updatedAt
      `)

      if (!clonedProject) {
        throw new Error('Failed to create cloned project')
      }

      const [sourcePrompts, sourceRouteLinks, sourceArticles, sourceSummaryJudgments] = await Promise.all([
        tx.queryJson<{
          promptId: string
          order: number | null
          archived: boolean
          enabled: boolean
          originalText: string
          transformedText: string | null
          promptHeading: string | null
          type: string | null
          promptArchived: boolean
          criteriaDisposition: 'include' | 'exclude' | 'combined' | null
          criteriaSectionKey: string | null
          criteriaSectionLabel: string | null
        }>(`
          SELECT
            pp.prompt_id AS promptId,
            pp.prompt_order AS "order",
            pp.archived AS archived,
            pp.enabled AS enabled,
            p.original_text AS originalText,
            p.transformed_text AS transformedText,
            p.prompt_heading AS promptHeading,
            p.type AS type,
            p.archived AS promptArchived,
            pp.criteria_disposition AS criteriaDisposition,
            pp.criteria_section_key AS criteriaSectionKey,
            pp.criteria_section_label AS criteriaSectionLabel
          FROM app.project_prompt pp
          INNER JOIN app.prompt p ON p.id = pp.prompt_id
          WHERE pp.project_id = '${escapeSqlString(params.id)}'
          ORDER BY pp.prompt_order ASC NULLS LAST
        `),
        tx.queryJson<{importRouteId: string}>(`
          SELECT import_route_id AS importRouteId
          FROM app.project_import_route
          WHERE project_id = '${escapeSqlString(params.id)}'
        `),
        tx.queryJson<{articleId: string}>(`
          SELECT article_id AS articleId
          FROM app.project_article
          WHERE project_id = '${escapeSqlString(params.id)}'
        `),
        sourceProject.humanJudgmentMode === 'summary'
          ? tx.queryJson<{answer: string | null; articleId: string; origin: 'covidence_import' | 'manual_override'}>(`
              SELECT article_id AS articleId, answer, origin
              FROM app.judgment_human_summary
              WHERE project_id = '${escapeSqlString(params.id)}'
            `)
          : Promise.resolve([]),
      ])

      if (sourcePrompts.length > 0) {
        for (const prompt of sourcePrompts) {
          await tx.run(`
            INSERT INTO app.project_prompt (
              id,
              project_id,
              prompt_id,
              prompt_order,
              archived,
              enabled,
              origin_project_id,
              criteria_disposition,
              criteria_section_key,
              criteria_section_label
            )
            VALUES (
              '${escapeSqlString(crypto.randomUUID())}',
              '${escapeSqlString(clonedProject.id)}',
              '${escapeSqlString(prompt.promptId)}',
              ${prompt.order ?? 0},
              ${prompt.archived ? 'TRUE' : 'FALSE'},
              ${prompt.enabled ? 'TRUE' : 'FALSE'},
              NULL,
              ${getSqlLiteral(prompt.criteriaDisposition)},
              ${getSqlLiteral(prompt.criteriaSectionKey)},
              ${getSqlLiteral(prompt.criteriaSectionLabel)}
            )
          `)
          await appendPromptConfigReviewServingDelta(tx, {
            changedPromptConfigFields: ['promptOrder', 'archived', 'enabled'],
            projectId: clonedProject.id,
            promptId: prompt.promptId,
            sourceMutationKey: `projectClonePrompt|${params.id}|${clonedProject.id}|${prompt.promptId}`,
            sourceOperation: 'insert',
          })
        }
      }

      if (sourceRouteLinks.length > 0) {
        await tx.run(`
          INSERT INTO app.project_import_route (id, project_id, import_route_id)
          VALUES ${sourceRouteLinks
            .map((link) => {
              return `(${getQuotedStringList([crypto.randomUUID(), clonedProject.id, link.importRouteId]).join(', ')})`
            })
            .join(', ')}
        `)
      }

      if (sourceArticles.length > 0) {
        const projectArticleRows = sourceArticles.map((article) => {
          return {articleId: article.articleId, projectArticleId: crypto.randomUUID()}
        })

        await tx.run(`
          INSERT INTO app.project_article (id, project_id, article_id, imported_from_project_id)
          VALUES ${projectArticleRows
            .map((row) => {
              return `(${getQuotedStringList([row.projectArticleId, clonedProject.id, row.articleId, params.id]).join(', ')})`
            })
            .join(', ')}
        `)

        await appendProjectScopeArticleReviewServingDeltas(
          tx,
          projectArticleRows.map((row) => {
            return {
              articleId: row.articleId,
              changeKind: 'projectScope.article.added' as const,
              projectArticleId: row.projectArticleId,
              projectId: clonedProject.id,
              sourceMutationKey: `projectCloneArticle|${params.id}|${clonedProject.id}|${row.projectArticleId}`,
              sourceOperation: 'insert' as const,
            }
          }),
        )
      }

      if (sourceProject.humanJudgmentMode === 'summary' && sourceSummaryJudgments.length > 0) {
        await tx.run(`
          INSERT INTO app.judgment_human_summary (id, project_id, article_id, answer, origin)
          VALUES ${sourceSummaryJudgments
            .map((judgment) => {
              return `(${getQuotedStringList([crypto.randomUUID(), clonedProject.id, judgment.articleId]).join(', ')}, ${getSqlLiteral(judgment.answer)}, ${getSqlLiteral(judgment.origin)})`
            })
            .join(', ')}
        `)
        await appendHumanJudgmentReviewServingDeltas(
          tx,
          sourceSummaryJudgments.map((judgment) => {
            const humanJudgmentKey = `${clonedProject.id}:${judgment.articleId}:summary`

            return {
              answer: judgment.answer,
              articleId: judgment.articleId,
              humanJudgmentKey,
              projectId: clonedProject.id,
              sourceMutationKey: `projectCloneHumanSummary|${params.id}|${humanJudgmentKey}`,
              sourceOperation: 'insert' as const,
              sourceRowId: humanJudgmentKey,
              sourceTable: 'app.judgment_human_summary',
            }
          }),
        )
      }

      await appendProjectReviewConfigDeltaIfNeeded(tx, {
        changedReviewConfigFields: [
          'modelId',
          'modelExecutionIdentity',
          'humanJudgmentMode',
          'useTitle',
          'useAbstract',
          'useFulltext',
          'useFulltextNoImages',
          ...(sourcePrompts.length > 0 ? (['promptMembership'] as const) : []),
          ...(sourceRouteLinks.length > 0 ? (['importRoutes'] as const) : []),
        ],
        projectId: clonedProject.id,
        sourceMutationKey: `projectClone|${params.id}|${clonedProject.id}`,
        sourceOperation: 'insert',
      })

      const clonedDirtyArticleRows = await tx.queryJson<{articleId: string}>(`
        SELECT article_id AS articleId
        FROM app.project_article
        WHERE project_id = '${escapeSqlString(clonedProject.id)}'
        UNION
        SELECT article_import_route.article_id AS articleId
        FROM app.project_import_route project_import_route
        INNER JOIN app.article_import_route article_import_route
          ON article_import_route.import_route_id = project_import_route.import_route_id
        WHERE project_import_route.project_id = '${escapeSqlString(clonedProject.id)}'
        ORDER BY articleId ASC
      `)

      await getProjectMartDirtyRefreshStateService().markProjectsDirtyAtomically({
        projects: [
          {
            articleIds: clonedDirtyArticleRows.map((row) => {
              return row.articleId
            }),
            projectId: clonedProject.id,
          },
        ],
        reason: 'ProjectsRoutes.clone',
        runner: tx,
      })

      return getProjectValue(clonedProject)
    })) as ReturnType<typeof getProjectValue>

    return {data: result}
  })
