import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {type ReviewServingIdentityValue} from './reviewProjectionIdentity.ts'
import {
  type ReviewServingComponentRequirements,
  type ReviewServingCountAvailability,
  type ReviewServingOptionalComponentState,
  type ReviewServingProjectionComponent,
  type ReviewServingRequiredComponentState,
  type ReviewServingSearchAvailability,
  type ReviewServingSnapshotComponentStates,
} from './reviewServingContracts.ts'
import {
  getReviewServingProjectionIdentityManifest,
  type ReviewServingManifestRepositoryTransaction,
  type ReviewServingProjectionIdentityManifest,
  type ReviewServingSnapshotManifest,
  type ReviewServingSnapshotManifestInput,
} from './reviewServingManifestRepository.ts'
import {type ReviewServingProjectionComponentIdentity} from './reviewServingProjectorDomain.ts'

export type ReviewServingSnapshotPromotionDatabase = ReviewServingManifestRepositoryTransaction

export type ComposeReviewServingCandidateSnapshotInput = {
  componentIdentities: Partial<Record<ReviewServingProjectionComponent, ReviewServingProjectionComponentIdentity>>
  componentRequirements: ReviewServingComponentRequirements
  composedIdentity: ReviewServingIdentityValue
  projectId: string
  reviewConfigHash?: string | null
  selectedImportSnapshotId: string
  snapshotId: string
  sourceWatermarks: ReviewServingIdentityValue
}

export type ReviewServingSnapshotValidationResult =
  | {candidate: ReviewServingSnapshotManifest; ok: true; validationResult: ReviewServingIdentityValue}
  | {candidate: ReviewServingSnapshotManifest; error: string; ok: false; validationResult: ReviewServingIdentityValue}

type SelectedImportSnapshotStatusRow = {status: string}
type ReviewServingSnapshotMaterializationValidationRow = {
  enabledPromptCount?: number | null
  missingQueueArticleCount?: number | null
  nullLlmStatusRowCount?: number | null
}

const completeManifestStatuses = ['active', 'candidate'] as const

const getOptionalComponentState = (
  manifest: ReviewServingProjectionIdentityManifest,
): ReviewServingOptionalComponentState => {
  return {
    baseGeneration: String(manifest.baseGeneration),
    component: manifest.projectionComponent,
    patchWatermark: String(manifest.patchWatermark),
    projectionIdentity: manifest.projectionIdentity,
    requirement: 'optional',
  }
}

const getRequiredComponentState = (
  manifest: ReviewServingProjectionIdentityManifest,
): ReviewServingRequiredComponentState => {
  return {
    baseGeneration: String(manifest.baseGeneration),
    component: manifest.projectionComponent,
    patchWatermark: String(manifest.patchWatermark),
    projectionIdentity: manifest.projectionIdentity,
    requirement: 'required',
  }
}

const componentSourceWatermarkKeys: Record<ReviewServingProjectionComponent, readonly string[]> = {
  display: ['reviewChange', 'review-change'],
  humanStatus: [
    'reviewChange',
    'review-change',
    'importRunArticle',
    'import-run-article',
    'projectScope',
    'project-scope',
  ],
  judgmentInputContent: ['reviewChange', 'review-change'],
  llmStatus: [
    'reviewChange',
    'review-change',
    'importRunArticle',
    'import-run-article',
    'projectScope',
    'project-scope',
  ],
  payload: ['reviewChange', 'review-change', 'importRunArticle', 'import-run-article', 'projectScope', 'project-scope'],
  posting: ['reviewChange', 'review-change', 'importRunArticle', 'import-run-article', 'projectScope', 'project-scope'],
  projectScope: [
    'reviewChange',
    'review-change',
    'importRunArticle',
    'import-run-article',
    'projectScope',
    'project-scope',
  ],
  queue: ['reviewChange', 'review-change', 'importRunArticle', 'import-run-article', 'projectScope', 'project-scope'],
  search: ['reviewChange', 'review-change', 'importRunArticle', 'import-run-article', 'projectScope', 'project-scope'],
  selectedImport: [
    'reviewChange',
    'review-change',
    'importRunArticle',
    'import-run-article',
    'projectScope',
    'project-scope',
  ],
  summary: ['reviewChange', 'review-change', 'importRunArticle', 'import-run-article', 'projectScope', 'project-scope'],
}

const getNumericObjectValue = (sourceWatermarks: ReviewServingIdentityValue, key: string) => {
  const values =
    sourceWatermarks !== null && typeof sourceWatermarks === 'object' && !Array.isArray(sourceWatermarks)
      ? (sourceWatermarks as Record<string, ReviewServingIdentityValue>)
      : null
  const value = values?.[key]

  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const getRequiredSourceWatermark = (
  sourceWatermarks: ReviewServingIdentityValue,
  component: ReviewServingProjectionComponent,
) => {
  const componentValue = getNumericObjectValue(sourceWatermarks, component)
  const sourceValues = componentSourceWatermarkKeys[component].flatMap((key) => {
    const value = getNumericObjectValue(sourceWatermarks, key)

    return value === null ? [] : [value]
  })

  return componentValue ?? (sourceValues.length === 0 ? 0 : Math.max(...sourceValues))
}

const getRequiredSourceWatermarks = (
  sourceWatermarks: ReviewServingIdentityValue,
  component: ReviewServingProjectionComponent,
) => {
  const componentValue = getNumericObjectValue(sourceWatermarks, component)
  const sourceEntries = componentSourceWatermarkKeys[component].flatMap((key) => {
    const value = getNumericObjectValue(sourceWatermarks, key)

    return value === null ? [] : [[key, value] as const]
  })

  return componentValue === null ? Object.fromEntries(sourceEntries) : {[component]: componentValue}
}

const getManifestCompletenessError = (
  manifest: ReviewServingProjectionIdentityManifest | null,
  component: ReviewServingProjectionComponent,
) => {
  return manifest === null
    ? `required component ${component} has no manifest`
    : completeManifestStatuses.includes(manifest.status as (typeof completeManifestStatuses)[number])
      ? null
      : `required component ${component} is ${manifest.status}`
}

const getReviewConfigError = (manifest: ReviewServingProjectionIdentityManifest, reviewConfigHash: string | null) => {
  return manifest.reviewConfigHash !== null && manifest.reviewConfigHash !== reviewConfigHash
    ? `component ${manifest.projectionComponent} review config ${manifest.reviewConfigHash} does not match snapshot ${reviewConfigHash}`
    : null
}

const getWatermarkError = (manifest: ReviewServingProjectionIdentityManifest, requiredSourceWatermark: number) => {
  return manifest.inputWatermark < requiredSourceWatermark
    ? `component ${manifest.projectionComponent} input watermark ${manifest.inputWatermark} is behind source ${requiredSourceWatermark}`
    : null
}

const getSourcePartitionWatermarkError = (
  manifest: ReviewServingProjectionIdentityManifest,
  requiredSourceWatermarks: Record<string, number>,
) => {
  const entries = Object.entries(requiredSourceWatermarks)
  const missingEntry = entries.find(([sourceKey, requiredWatermark]) => {
    return (manifest.inputWatermarks[sourceKey] ?? 0) < requiredWatermark
  })

  return missingEntry === undefined
    ? null
    : `component ${manifest.projectionComponent} input watermark ${manifest.inputWatermarks[missingEntry[0]] ?? 0} for source ${missingEntry[0]} is behind source ${missingEntry[1]}`
}

const getComponentStateConsistencyError = (
  manifest: ReviewServingProjectionIdentityManifest | null,
  state: {
    baseGeneration: string
    component: ReviewServingProjectionComponent
    patchWatermark: string
    projectionIdentity: string
  },
) => {
  return manifest === null
    ? `component ${state.component} state has no manifest`
    : manifest.baseGeneration !== Number(state.baseGeneration)
      ? `component ${state.component} base generation does not match manifest`
      : manifest.patchWatermark !== Number(state.patchWatermark)
        ? `component ${state.component} patch watermark does not match manifest`
        : manifest.projectionIdentity !== state.projectionIdentity
          ? `component ${state.component} projection identity does not match manifest`
          : null
}

const getSelectedImportSnapshotCompleted = async (
  selectedImportSnapshotId: string | null,
  database: ReviewServingSnapshotPromotionDatabase,
) => {
  const rows =
    selectedImportSnapshotId === null
      ? []
      : await database.queryJson<SelectedImportSnapshotStatusRow>(`
          SELECT status
          FROM app.review_selected_import_snapshot
          WHERE selected_import_snapshot_id = ${getSqlLiteral(selectedImportSnapshotId)}
          LIMIT 1
        `)

  return rows[0]?.status === 'completed'
}

const getManifestForState = async (
  projectId: string,
  state: {component: ReviewServingProjectionComponent; projectionIdentity: string},
  database: ReviewServingSnapshotPromotionDatabase,
) => {
  return getReviewServingProjectionIdentityManifest(
    {projectId, projectionComponent: state.component, projectionIdentity: state.projectionIdentity},
    database,
  )
}

const getRequiredManifestValidationError = async (
  candidate: ReviewServingSnapshotManifest,
  state: ReviewServingSnapshotComponentStates['required'][number],
  database: ReviewServingSnapshotPromotionDatabase,
) => {
  const manifest = await getManifestForState(candidate.projectId, state, database)
  const requiredSourceWatermark = getRequiredSourceWatermark(candidate.sourceWatermarks, state.component)
  const requiredSourceWatermarks = getRequiredSourceWatermarks(candidate.sourceWatermarks, state.component)

  return (
    getManifestCompletenessError(manifest, state.component)
    ?? (manifest === null ? null : getReviewConfigError(manifest, candidate.reviewConfigHash))
    ?? (manifest === null ? null : getSourcePartitionWatermarkError(manifest, requiredSourceWatermarks))
    ?? (manifest === null ? null : getWatermarkError(manifest, requiredSourceWatermark))
    ?? getComponentStateConsistencyError(manifest, state)
  )
}

const getOptionalManifestValidationError = async (
  candidate: ReviewServingSnapshotManifest,
  state: ReviewServingSnapshotComponentStates['optional'][number],
  database: ReviewServingSnapshotPromotionDatabase,
) => {
  const manifest = await getManifestForState(candidate.projectId, state, database)
  const requiredSourceWatermark = getRequiredSourceWatermark(candidate.sourceWatermarks, state.component)
  const requiredSourceWatermarks = getRequiredSourceWatermarks(candidate.sourceWatermarks, state.component)

  return (
    getManifestCompletenessError(manifest, state.component)
    ?? (manifest === null ? null : getReviewConfigError(manifest, candidate.reviewConfigHash))
    ?? (manifest === null ? null : getSourcePartitionWatermarkError(manifest, requiredSourceWatermarks))
    ?? (manifest === null ? null : getWatermarkError(manifest, requiredSourceWatermark))
    ?? getComponentStateConsistencyError(manifest, state)
  )
}

const getCandidateValidationReport = async (
  candidate: ReviewServingSnapshotManifest,
  database: ReviewServingSnapshotPromotionDatabase,
) => {
  const selectedImportCompleted = await getSelectedImportSnapshotCompleted(candidate.selectedImportSnapshotId, database)
  const requiredErrors = await candidate.componentState.required.reduce<Promise<readonly string[]>>(
    async (previous, state) => {
      const errors = await previous
      const error = await getRequiredManifestValidationError(candidate, state, database)

      return error === null ? errors : [...errors, error]
    },
    Promise.resolve([]),
  )
  const optionalErrors = await candidate.componentState.optional.reduce<Promise<readonly string[]>>(
    async (previous, state) => {
      const errors = await previous
      const error = await getOptionalManifestValidationError(candidate, state, database)

      return error === null ? errors : [...errors, error]
    },
    Promise.resolve([]),
  )
  const missingRequiredComponents = candidate.requiredComponents.filter((component) => {
    return !candidate.componentState.required.some((state) => {
      return state.component === component
    })
  })
  const materializationErrors =
    requiredErrors.length > 0 || missingRequiredComponents.length > 0
      ? []
      : await getMaterializationValidationErrors(candidate, database)
  const errors = [
    ...(selectedImportCompleted ? [] : ['selected import snapshot is not completed']),
    ...missingRequiredComponents.map((component) => {
      return `required component ${component} is missing from snapshot state`
    }),
    ...requiredErrors,
    ...materializationErrors,
  ]

  return {error: errors[0] ?? null, optionalErrors}
}

const hasRequiredComponent = (
  candidate: ReviewServingSnapshotManifest,
  component: ReviewServingProjectionComponent,
) => {
  return candidate.requiredComponents.includes(component)
}

const getEnabledPromptCountSql = (projectId: string) => {
  return `(
    SELECT COUNT(DISTINCT prompt.id)
    FROM app.project_prompt project_prompt
    INNER JOIN app.prompt prompt
      ON prompt.id = project_prompt.prompt_id
    WHERE project_prompt.project_id = ${getSqlLiteral(projectId)}
      AND project_prompt.enabled
      AND NOT project_prompt.archived
      AND COALESCE(prompt.archived, FALSE) = FALSE
  )`
}

const getLlmStatusMaterializationValidationError = async (
  candidate: ReviewServingSnapshotManifest,
  database: ReviewServingSnapshotPromotionDatabase,
) => {
  if (!hasRequiredComponent(candidate, 'llmStatus') || candidate.reviewConfigHash === null) {
    return null
  }

  const [row] = await database.queryJson<ReviewServingSnapshotMaterializationValidationRow>(`
    WITH enabled_prompt_count(prompt_count) AS (
      SELECT ${getEnabledPromptCountSql(candidate.projectId)}
    )
    SELECT
      COUNT(*) FILTER (
        WHERE prompt_count > 0
          AND (state.has_llm_list_mode OR state.has_both_list_mode OR state.has_unassessed_list_mode)
          AND state.llm_status IS NULL
      ) AS nullLlmStatusRowCount
    FROM mart.review_article_serving_list_mode_state_v4 state
    CROSS JOIN enabled_prompt_count
    WHERE state.project_id = ${getSqlLiteral(candidate.projectId)}
      AND state.review_config_hash IS NOT DISTINCT FROM ${getSqlLiteral(candidate.reviewConfigHash)}
      AND state.snapshot_id = ${getSqlLiteral(candidate.snapshotId)}
  `)

  const missingCount = row?.nullLlmStatusRowCount ?? 0

  return missingCount > 0
    ? `required component llmStatus has ${missingCount} list-mode rows with NULL status despite enabled prompts`
    : null
}

const getQueueMaterializationValidationError = async (
  candidate: ReviewServingSnapshotManifest,
  database: ReviewServingSnapshotPromotionDatabase,
) => {
  if (!hasRequiredComponent(candidate, 'queue') || candidate.reviewConfigHash === null) {
    return null
  }

  const [row] = await database.queryJson<ReviewServingSnapshotMaterializationValidationRow>(`
    WITH enabled_prompt_count(prompt_count) AS (
      SELECT ${getEnabledPromptCountSql(candidate.projectId)}
    )
    SELECT
      COUNT(DISTINCT state.article_id) FILTER (
        WHERE prompt_count > 0
          AND state.has_unassessed_list_mode
          AND state.llm_status = 'unanswered'
          AND queue.article_id IS NULL
      ) AS missingQueueArticleCount
    FROM mart.review_article_serving_list_mode_state_v4 state
    CROSS JOIN enabled_prompt_count
    LEFT JOIN mart.review_unassessed_queue_article_rank_serving_v4 queue
      ON queue.project_id = state.project_id
      AND queue.review_config_hash IS NOT DISTINCT FROM state.review_config_hash
      AND queue.snapshot_id = state.snapshot_id
      AND queue.queue_kind = 'unassessed'
      AND queue.article_id = state.article_id
    WHERE state.project_id = ${getSqlLiteral(candidate.projectId)}
      AND state.review_config_hash IS NOT DISTINCT FROM ${getSqlLiteral(candidate.reviewConfigHash)}
      AND state.snapshot_id = ${getSqlLiteral(candidate.snapshotId)}
  `)

  const missingCount = row?.missingQueueArticleCount ?? 0

  return missingCount > 0
    ? `required component queue is missing ${missingCount} unassessed article-rank rows for unanswered list-mode articles`
    : null
}

const getMaterializationValidationErrors = async (
  candidate: ReviewServingSnapshotManifest,
  database: ReviewServingSnapshotPromotionDatabase,
) => {
  const errors = await Promise.all([
    getLlmStatusMaterializationValidationError(candidate, database),
    getQueueMaterializationValidationError(candidate, database),
  ])

  return errors.filter((error): error is string => {
    return error !== null
  })
}

const getValidationResultValue = (
  candidate: ReviewServingSnapshotManifest,
  input: {error: string | null; optionalErrors: readonly string[]},
) => {
  return {
    error: input.error,
    ok: input.error === null,
    optionalComponentErrorCount: input.optionalErrors.length,
    optionalComponentErrors: input.optionalErrors,
    requiredComponentCount: candidate.componentState.required.length,
    snapshotId: candidate.snapshotId,
  }
}

const getAvailableManifest = async (
  identity: ReviewServingProjectionComponentIdentity | undefined,
  database: ReviewServingSnapshotPromotionDatabase,
) => {
  return identity === undefined ? null : getReviewServingProjectionIdentityManifest(identity, database)
}

export const composeReviewServingCandidateSnapshotManifest = async (
  input: ComposeReviewServingCandidateSnapshotInput,
  database: ReviewServingSnapshotPromotionDatabase = getAppDatabaseService(),
): Promise<ReviewServingSnapshotManifestInput> => {
  const requiredManifests = await input.componentRequirements.requiredComponents.reduce<
    Promise<readonly ReviewServingProjectionIdentityManifest[]>
  >(async (previous, component) => {
    const manifests = await previous
    const manifest = await getAvailableManifest(input.componentIdentities[component], database)

    return manifest === null ? manifests : [...manifests, manifest]
  }, Promise.resolve([]))
  const optionalManifests = await input.componentRequirements.optionalComponents.reduce<
    Promise<readonly ReviewServingProjectionIdentityManifest[]>
  >(async (previous, component) => {
    const manifests = await previous
    const manifest = await getAvailableManifest(input.componentIdentities[component], database)

    return manifest === null ? manifests : [...manifests, manifest]
  }, Promise.resolve([]))

  return {
    componentRequirements: input.componentRequirements,
    componentState: {
      optional: optionalManifests.map((manifest) => {
        return getOptionalComponentState(manifest)
      }),
      required: requiredManifests.map((manifest) => {
        return getRequiredComponentState(manifest)
      }),
    },
    composedIdentity: input.composedIdentity,
    projectId: input.projectId,
    reviewConfigHash: input.reviewConfigHash ?? null,
    selectedImportSnapshotId: input.selectedImportSnapshotId,
    snapshotId: input.snapshotId,
    sourceWatermarks: input.sourceWatermarks,
  }
}

export const validateReviewServingCandidateSnapshotManifest = async (
  candidate: ReviewServingSnapshotManifest,
  database: ReviewServingSnapshotPromotionDatabase = getAppDatabaseService(),
): Promise<ReviewServingSnapshotValidationResult> => {
  const report = await getCandidateValidationReport(candidate, database)
  const validationResult = getValidationResultValue(candidate, report)

  return report.error === null
    ? {candidate, ok: true, validationResult}
    : {candidate, error: report.error, ok: false, validationResult}
}

export const getReviewServingOptionalComponentAvailability = (input: {
  component: ReviewServingProjectionComponent
  hasActiveSnapshot: boolean
  optionalComponents: readonly ReviewServingProjectionComponent[]
  optionalStatePresent: boolean
}): ReviewServingCountAvailability | ReviewServingSearchAvailability => {
  return !input.hasActiveSnapshot
    ? 'unavailable'
    : !input.optionalComponents.includes(input.component)
      ? 'async'
      : input.optionalStatePresent
        ? 'ready'
        : 'indexing'
}
