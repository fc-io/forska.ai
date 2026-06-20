import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getJsonValue, getSqlLiteral} from '../services/appQueryHelpers.ts'
import {getStableReviewServingJson, type ReviewServingIdentityValue} from './reviewProjectionIdentity.ts'
import {
  type ReviewServingOptionalComponentState,
  type ReviewServingProjectionComponent,
  type ReviewServingRequiredComponentState,
  type ReviewServingSnapshotComponentStates,
} from './reviewServingContracts.ts'
import {type ReviewServingSnapshotManifest} from './reviewServingManifestRepository.ts'

export type ReviewServingRetentionServiceTransaction = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

export type ReviewServingRetentionServiceDatabase = ReviewServingRetentionServiceTransaction & {
  transaction: <T>(operation: (tx: ReviewServingRetentionServiceTransaction) => Promise<T>) => Promise<T>
}

export type ReviewServingPatchBudget = {maxPatchRows: number; maxPatchWatermarks: number}

export type ReviewServingRetentionCleanupInput = {
  batchSize: number
  now: Date | string
  projectId: string
  reviewConfigHash?: string | null
}

export type ReviewServingPatchBudgetAssessment = {
  baseGeneration: number
  component: ReviewServingProjectionComponent
  patchRows: number
  patchWatermark: number
  patchWatermarks: number
  projectionIdentity: string
  shouldCompact: boolean
}

export type ReviewServingCompactionResult = {compactedComponents: readonly ReviewServingPatchBudgetAssessment[]}

export type ReviewServingRetentionCleanupResult = {retentionScope: string}

type PatchBudgetRow = {patchRows: number; patchWatermarks: number}

type RetentionStateRow = {
  baseGeneration: number | null
  cursorJson: unknown
  patchWatermark: number | null
  snapshotId: string | null
}

type PatchComponentSpec = {component: ReviewServingProjectionComponent; identityColumn: string | null; table: string}

type CleanupTableSpec = {keyColumn: string; protectedPredicate: string; table: string}

const defaultPatchBudget: ReviewServingPatchBudget = {maxPatchRows: 50_000, maxPatchWatermarks: 25}
const defaultRetentionCleanupBatchSize = 512
const defaultRetentionCleanupTargetLimit = 16

const patchComponentSpecs: readonly PatchComponentSpec[] = [
  {component: 'display', identityColumn: 'display_identity', table: 'mart.review_article_display_patch_v4'},
  {component: 'llmStatus', identityColumn: null, table: 'mart.review_llm_status_patch_v4'},
  {component: 'humanStatus', identityColumn: null, table: 'mart.review_human_status_patch_v4'},
  {component: 'queue', identityColumn: 'queue_identity', table: 'mart.review_queue_patch_v4'},
  {component: 'posting', identityColumn: 'posting_identity', table: 'mart.review_article_filter_posting_patch_v4'},
]

const cleanupTableSpecs: readonly CleanupTableSpec[] = [
  {keyColumn: 'snapshot_id', protectedPredicate: 'snapshot_id', table: 'mart.review_article_serving_v4'},
  {keyColumn: 'snapshot_id', protectedPredicate: 'snapshot_id', table: 'mart.review_article_serving_payload_v4'},
  {keyColumn: 'snapshot_id', protectedPredicate: 'snapshot_id', table: 'mart.review_article_filter_posting_serving_v4'},
  {keyColumn: 'snapshot_id', protectedPredicate: 'snapshot_id', table: 'mart.review_filter_posting_stats_v4'},
  {
    keyColumn: 'snapshot_id',
    protectedPredicate: 'snapshot_id',
    table: 'mart.review_article_judgment_detail_serving_v4',
  },
  {keyColumn: 'snapshot_id', protectedPredicate: 'snapshot_id', table: 'mart.review_article_summary_contribution_v4'},
  {keyColumn: 'snapshot_id', protectedPredicate: 'snapshot_id', table: 'mart.review_article_count_serving_v4'},
  {keyColumn: 'snapshot_id', protectedPredicate: 'snapshot_id', table: 'mart.review_filter_facet_serving_v4'},
  {keyColumn: 'snapshot_id', protectedPredicate: 'snapshot_id', table: 'mart.review_filter_option_serving_v4'},
  {keyColumn: 'snapshot_id', protectedPredicate: 'snapshot_id', table: 'mart.review_unassessed_queue_serving_v4'},
  {keyColumn: 'snapshot_id', protectedPredicate: 'snapshot_id', table: 'mart.review_title_search_serving_v4'},
  {
    keyColumn: 'selected_import_snapshot_id',
    protectedPredicate: 'selected_import_snapshot_id',
    table: 'app.review_selected_article_import_v4',
  },
  {
    keyColumn: 'selected_import_snapshot_id',
    protectedPredicate: 'selected_import_snapshot_id',
    table: 'mart.review_selected_import_patch_v4',
  },
]

const getReviewServingRetentionDatabase = () => {
  return getAppDatabaseService() as ReviewServingRetentionServiceDatabase
}

const getTimestampLiteral = (value: Date | string) => {
  return value instanceof Date ? getSqlLiteral(value) : `TIMESTAMPTZ ${getSqlLiteral(value)}`
}

const getJsonLiteral = (value: ReviewServingIdentityValue) => {
  return `${getSqlLiteral(getStableReviewServingJson(value))}::JSON`
}

const getRetentionScope = (input: {projectId: string; reviewConfigHash?: string | null}) => {
  return `reviewServing:${input.projectId}:${input.reviewConfigHash ?? 'global'}`
}

const getCompactionRetentionScope = (input: {
  component: ReviewServingProjectionComponent
  projectId: string
  projectionIdentity: string
  snapshotId: string
}) => {
  return `reviewServingCompact:${input.projectId}:${input.snapshotId}:${input.component}:${input.projectionIdentity}`
}

const getActivePinPredicate = (now: Date | string) => {
  return `released_at IS NULL AND ref_count > 0 AND expires_at > ${getTimestampLiteral(now)}`
}

const getAllComponentStates = (componentState: ReviewServingSnapshotComponentStates) => {
  return [...componentState.required, ...componentState.optional]
}

const getComposedComponentState = (componentState: ReviewServingSnapshotComponentStates) => {
  return {
    optional: componentState.optional.map((state) => {
      return {
        baseGeneration: state.baseGeneration,
        component: state.component,
        patchWatermark: state.patchWatermark,
        projectionIdentity: state.projectionIdentity,
      }
    }),
    required: componentState.required.map((state) => {
      return {
        baseGeneration: state.baseGeneration,
        component: state.component,
        patchWatermark: state.patchWatermark,
        projectionIdentity: state.projectionIdentity,
      }
    }),
  }
}

const getCompactedComposedIdentity = (
  composedIdentity: ReviewServingIdentityValue,
  componentState: ReviewServingSnapshotComponentStates,
) => {
  return composedIdentity !== null && typeof composedIdentity === 'object' && !Array.isArray(composedIdentity)
    ? {...composedIdentity, componentStates: getComposedComponentState(componentState)}
    : composedIdentity
}

const getPatchSpec = (component: ReviewServingProjectionComponent) => {
  return patchComponentSpecs.find((spec) => {
    return spec.component === component
  })
}

const getPatchBudgetIdentityPredicate = (
  spec: PatchComponentSpec,
  state: ReturnType<typeof getAllComponentStates>[number],
) => {
  return spec.identityColumn === null
    ? ''
    : `\n      AND ${spec.identityColumn} = ${getSqlLiteral(state.projectionIdentity)}`
}

const getSelectedImportPatchBudget = async (
  candidate: ReviewServingSnapshotManifest,
  database: ReviewServingRetentionServiceTransaction,
) => {
  const [row] = await database.queryJson<PatchBudgetRow>(`
    SELECT
      CAST(COUNT(*) AS INTEGER) AS patchRows,
      CAST(COUNT(DISTINCT patch_watermark) AS INTEGER) AS patchWatermarks
    FROM mart.review_selected_import_patch_v4
    WHERE project_id = ${getSqlLiteral(candidate.projectId)}
      AND selected_import_snapshot_id = ${getSqlLiteral(candidate.selectedImportSnapshotId)}
  `)

  return row ?? {patchRows: 0, patchWatermarks: 0}
}

const getPatchBudget = async (
  projectId: string,
  state: ReturnType<typeof getAllComponentStates>[number],
  database: ReviewServingRetentionServiceTransaction,
) => {
  const spec = getPatchSpec(state.component)

  if (spec === undefined) {
    return {patchRows: 0, patchWatermarks: 0}
  }

  const identityPredicate = getPatchBudgetIdentityPredicate(spec, state)
  const [row] = await database.queryJson<PatchBudgetRow>(`
    SELECT
      CAST(COUNT(*) AS INTEGER) AS patchRows,
      CAST(COUNT(DISTINCT patch_watermark) AS INTEGER) AS patchWatermarks
    FROM ${spec.table}
    WHERE project_id = ${getSqlLiteral(projectId)}
      ${identityPredicate}
      AND base_generation = ${getSqlLiteral(Number(state.baseGeneration))}
  `)

  return row ?? {patchRows: 0, patchWatermarks: 0}
}

const getAssessment = (
  state: ReturnType<typeof getAllComponentStates>[number],
  row: PatchBudgetRow,
  budget: ReviewServingPatchBudget,
) => {
  return {
    baseGeneration: Number(state.baseGeneration),
    component: state.component,
    patchRows: Number(row.patchRows),
    patchWatermark: Number(state.patchWatermark),
    patchWatermarks: Number(row.patchWatermarks),
    projectionIdentity: state.projectionIdentity,
    shouldCompact:
      Number(row.patchRows) > budget.maxPatchRows || Number(row.patchWatermarks) > budget.maxPatchWatermarks,
  } satisfies ReviewServingPatchBudgetAssessment
}

const getCompactedComponentState = (
  componentState: ReviewServingSnapshotComponentStates,
  compacted: readonly ReviewServingPatchBudgetAssessment[],
) => {
  const getCompactedState = <T extends ReturnType<typeof getAllComponentStates>[number]>(state: T): T => {
    const compaction = compacted.find((assessment) => {
      return assessment.component === state.component && assessment.projectionIdentity === state.projectionIdentity
    })

    return compaction === undefined
      ? state
      : ({...state, baseGeneration: String(compaction.baseGeneration + 1), patchWatermark: '0'} as T)
  }

  return {
    optional: componentState.optional.map((state): ReviewServingOptionalComponentState => {
      return getCompactedState(state)
    }),
    required: componentState.required.map((state): ReviewServingRequiredComponentState => {
      return getCompactedState(state)
    }),
  } satisfies ReviewServingSnapshotComponentStates
}

const writeRetentionMark = async (
  input: {
    baseGeneration: number
    cursor: ReviewServingIdentityValue | null
    patchWatermark: number
    retentionScope: string
    snapshotId: string | null
  },
  database: ReviewServingRetentionServiceTransaction,
) => {
  await database.run(`
    INSERT INTO app.review_serving_retention_mark (
      retention_scope,
      cutoff_snapshot_id,
      cutoff_base_generation,
      cutoff_patch_watermark,
      cleanup_cursor_json,
      last_cleaned_at,
      updated_at
    ) VALUES (
      ${getSqlLiteral(input.retentionScope)},
      ${getSqlLiteral(input.snapshotId)},
      ${getSqlLiteral(input.baseGeneration)},
      ${getSqlLiteral(input.patchWatermark)},
      ${input.cursor === null ? 'NULL' : getJsonLiteral(input.cursor)},
      current_timestamp,
      current_timestamp
    )
    ON CONFLICT(retention_scope) DO UPDATE SET
      cutoff_snapshot_id = excluded.cutoff_snapshot_id,
      cutoff_base_generation = excluded.cutoff_base_generation,
      cutoff_patch_watermark = excluded.cutoff_patch_watermark,
      cleanup_cursor_json = excluded.cleanup_cursor_json,
      last_cleaned_at = excluded.last_cleaned_at,
      updated_at = current_timestamp
  `)
}

const compactSelectedImportPatches = async (
  candidate: ReviewServingSnapshotManifest,
  database: ReviewServingRetentionServiceTransaction,
) => {
  await database.run(`
    INSERT INTO app.review_selected_article_import_v4 (
      project_id,
      project_scope_identity,
      selected_import_snapshot_id,
      article_id,
      import_route_id,
      selected_rank_key,
      selected_rank_numeric,
      publication_year,
      duplicate_flag,
      conflict_flag,
      tombstone,
      selected_import_updated_at
    )
    SELECT
      patch.project_id,
      patch.project_scope_identity,
      patch.selected_import_snapshot_id,
      patch.article_id,
      patch.import_route_id,
      patch.selected_rank_key,
      patch.selected_rank_numeric,
      patch.publication_year,
      COALESCE(patch.duplicate_flag, FALSE),
      COALESCE(patch.conflict_flag, FALSE),
      patch.tombstone,
      current_timestamp
    FROM mart.review_selected_import_patch_v4 patch
    WHERE patch.project_id = ${getSqlLiteral(candidate.projectId)}
      AND patch.selected_import_snapshot_id = ${getSqlLiteral(candidate.selectedImportSnapshotId)}
      AND NOT EXISTS (
        SELECT 1
        FROM mart.review_selected_import_patch_v4 newer
        WHERE newer.project_id = patch.project_id
          AND newer.project_scope_identity = patch.project_scope_identity
          AND newer.selected_import_snapshot_id = patch.selected_import_snapshot_id
          AND newer.article_id = patch.article_id
          AND newer.patch_watermark > patch.patch_watermark
      )
    ON CONFLICT(project_id, project_scope_identity, selected_import_snapshot_id, article_id) DO UPDATE SET
      import_route_id = excluded.import_route_id,
      selected_rank_key = excluded.selected_rank_key,
      selected_rank_numeric = excluded.selected_rank_numeric,
      publication_year = excluded.publication_year,
      duplicate_flag = excluded.duplicate_flag,
      conflict_flag = excluded.conflict_flag,
      tombstone = excluded.tombstone,
      selected_import_updated_at = excluded.selected_import_updated_at
  `)

  await database.run(`
    DELETE FROM mart.review_selected_import_patch_v4
    WHERE project_id = ${getSqlLiteral(candidate.projectId)}
      AND selected_import_snapshot_id = ${getSqlLiteral(candidate.selectedImportSnapshotId)}
  `)
}

const compactPatchComponent = async (
  candidate: ReviewServingSnapshotManifest,
  assessment: ReviewServingPatchBudgetAssessment,
  database: ReviewServingRetentionServiceTransaction,
) => {
  const nextBaseGeneration = assessment.baseGeneration + 1

  await writeRetentionMark(
    {
      baseGeneration: nextBaseGeneration,
      cursor: {component: assessment.component, compactedPatchRows: assessment.patchRows},
      patchWatermark: assessment.patchWatermark,
      retentionScope: getCompactionRetentionScope({
        ...assessment,
        projectId: candidate.projectId,
        snapshotId: candidate.snapshotId,
      }),
      snapshotId: candidate.snapshotId,
    },
    database,
  )

  if (assessment.component === 'selectedImport') {
    await compactSelectedImportPatches(candidate, database)
    await database.run(`
      UPDATE mart.review_article_serving_v4 serving
      SET base_generation = ${getSqlLiteral(nextBaseGeneration)}
      FROM app.review_serving_snapshot_manifest snapshot
      WHERE serving.project_id = ${getSqlLiteral(candidate.projectId)}
        AND serving.project_id = snapshot.project_id
        AND serving.snapshot_id = snapshot.snapshot_id
        AND snapshot.selected_import_snapshot_id = ${getSqlLiteral(candidate.selectedImportSnapshotId)}
        AND serving.base_generation = ${getSqlLiteral(assessment.baseGeneration)}
    `)
  } else {
    return
  }

  await database.run(`
    UPDATE app.review_projection_identity_manifest
    SET
      base_generation = ${getSqlLiteral(nextBaseGeneration)},
      patch_watermark = 0,
      patch_range_start = NULL,
      patch_range_end = NULL,
      updated_at = current_timestamp
    WHERE project_id = ${getSqlLiteral(candidate.projectId)}
      AND projection_component = ${getSqlLiteral(assessment.component)}
      AND projection_identity = ${getSqlLiteral(assessment.projectionIdentity)}
  `)
}

const getRetentionState = async (retentionScope: string, database: ReviewServingRetentionServiceTransaction) => {
  const rows = await database.queryJson<RetentionStateRow>(`
    SELECT
      cutoff_snapshot_id AS snapshotId,
      cutoff_base_generation AS baseGeneration,
      cutoff_patch_watermark AS patchWatermark,
      cleanup_cursor_json AS cursorJson
    FROM app.review_serving_retention_mark
    WHERE retention_scope = ${getSqlLiteral(retentionScope)}
    LIMIT 1
  `)

  return rows[0] ?? null
}

const getSupportedPatchCompactions = (assessments: readonly ReviewServingPatchBudgetAssessment[]) => {
  return assessments.filter((assessment) => {
    return assessment.shouldCompact && assessment.component === 'selectedImport'
  })
}

const getSelectedImportProtectedPredicate = (spec: CleanupTableSpec, now: Date | string) => {
  return spec.protectedPredicate !== 'selected_import_snapshot_id'
    ? 'FALSE'
    : `EXISTS (
        SELECT 1
        FROM app.review_serving_snapshot_manifest active_manifest
        LEFT JOIN app.review_serving_snapshot_manifest lkg_manifest
          ON lkg_manifest.project_id = active_manifest.project_id
          AND lkg_manifest.snapshot_id = active_manifest.last_known_good_snapshot_id
        WHERE active_manifest.project_id = candidate.project_id
          AND active_manifest.snapshot_status = 'active'
          AND lkg_manifest.selected_import_snapshot_id = candidate.selected_import_snapshot_id
      )
      OR EXISTS (
        SELECT 1
        FROM app.review_serving_snapshot_pin pin
        INNER JOIN app.review_serving_snapshot_manifest pinned_manifest
          ON pinned_manifest.project_id = pin.project_id
          AND pinned_manifest.snapshot_id = pin.snapshot_id
        WHERE pin.project_id = candidate.project_id
          AND pinned_manifest.selected_import_snapshot_id = candidate.selected_import_snapshot_id
          AND ${getActivePinPredicate(now)}
      )`
}

const getRetentionCursorIndex = (row: RetentionStateRow | null) => {
  const cursor = getJsonValue(row?.cursorJson ?? null) as {tableIndex?: number} | null

  return Math.max(0, Number(cursor?.tableIndex ?? 0))
}

const deleteCleanupBatch = async (
  input: ReviewServingRetentionCleanupInput & {spec: CleanupTableSpec},
  database: ReviewServingRetentionServiceTransaction,
) => {
  await database.run(`
    DELETE FROM ${input.spec.table}
    WHERE rowid IN (
        SELECT candidate.rowid
        FROM ${input.spec.table} candidate
        WHERE candidate.project_id = ${getSqlLiteral(input.projectId)}
          AND NOT EXISTS (
            SELECT 1
            FROM app.review_serving_snapshot_manifest active_manifest
            WHERE active_manifest.project_id = candidate.project_id
              AND active_manifest.snapshot_status = 'active'
              AND (
                active_manifest.snapshot_id = candidate.${input.spec.protectedPredicate}
                OR active_manifest.last_known_good_snapshot_id = candidate.${input.spec.protectedPredicate}
                OR active_manifest.selected_import_snapshot_id = candidate.${input.spec.protectedPredicate}
              )
          )
          AND NOT (${getSelectedImportProtectedPredicate(input.spec, input.now)})
          AND NOT EXISTS (
            SELECT 1
            FROM app.review_serving_snapshot_pin pin
            WHERE pin.project_id = candidate.project_id
              AND pin.snapshot_id = candidate.${input.spec.protectedPredicate}
              AND ${getActivePinPredicate(input.now)}
          )
        ORDER BY candidate.${input.spec.keyColumn}
        LIMIT ${getSqlLiteral(input.batchSize)}
      )
  `)
}

const deletePatchTableBatch = async (
  input: ReviewServingRetentionCleanupInput & {spec: PatchComponentSpec},
  database: ReviewServingRetentionServiceTransaction,
) => {
  await database.run(`
    DELETE FROM ${input.spec.table}
    WHERE rowid IN (
      SELECT candidate.rowid
      FROM ${input.spec.table} candidate
      WHERE candidate.project_id = ${getSqlLiteral(input.projectId)}
        AND NOT EXISTS (
        SELECT 1
        FROM app.review_projection_identity_manifest manifest
        WHERE manifest.project_id = ${getSqlLiteral(input.projectId)}
          AND manifest.projection_component = ${getSqlLiteral(input.spec.component)}
          AND manifest.base_generation = candidate.base_generation
      )
        AND NOT EXISTS (
        SELECT 1
        FROM (
          SELECT manifest.project_id, manifest.snapshot_id, manifest.component_state_json
          FROM app.review_serving_snapshot_manifest manifest
          WHERE manifest.project_id = ${getSqlLiteral(input.projectId)}
            AND manifest.snapshot_status = 'active'
          UNION ALL
          SELECT lkg.project_id, lkg.snapshot_id, lkg.component_state_json
          FROM app.review_serving_snapshot_manifest active_manifest
          INNER JOIN app.review_serving_snapshot_manifest lkg
            ON lkg.project_id = active_manifest.project_id
            AND lkg.snapshot_id = active_manifest.last_known_good_snapshot_id
          WHERE active_manifest.project_id = ${getSqlLiteral(input.projectId)}
            AND active_manifest.snapshot_status = 'active'
            AND active_manifest.last_known_good_snapshot_id IS NOT NULL
          UNION ALL
          SELECT pinned_manifest.project_id, pinned_manifest.snapshot_id, pinned_manifest.component_state_json
          FROM app.review_serving_snapshot_pin pin
          INNER JOIN app.review_serving_snapshot_manifest pinned_manifest
            ON pinned_manifest.project_id = pin.project_id
            AND pinned_manifest.snapshot_id = pin.snapshot_id
          WHERE pin.project_id = ${getSqlLiteral(input.projectId)}
            AND ${getActivePinPredicate(input.now)}
        ) protected_manifest
        WHERE protected_manifest.project_id = ${getSqlLiteral(input.projectId)}
          AND CAST(protected_manifest.component_state_json AS VARCHAR) LIKE '%' || ${getSqlLiteral(input.spec.component)} || '%'
          AND CAST(protected_manifest.component_state_json AS VARCHAR) LIKE '%' || CAST(candidate.base_generation AS VARCHAR) || '%'
      )
      ORDER BY candidate.${input.spec.identityColumn}, candidate.base_generation, candidate.patch_watermark
      LIMIT ${getSqlLiteral(input.batchSize)}
    )
  `)
}

export const assessReviewServingCandidatePatchBudgets = async (
  input: {budget?: ReviewServingPatchBudget; candidate: ReviewServingSnapshotManifest},
  database: ReviewServingRetentionServiceTransaction = getReviewServingRetentionDatabase(),
) => {
  const budget = input.budget ?? defaultPatchBudget
  const states = getAllComponentStates(input.candidate.componentState)
  const assessments = await states.reduce<Promise<readonly ReviewServingPatchBudgetAssessment[]>>(
    async (previous, state) => {
      const results = await previous
      const patchBudget =
        state.component === 'selectedImport'
          ? await getSelectedImportPatchBudget(input.candidate, database)
          : await getPatchBudget(input.candidate.projectId, state, database)

      return [...results, getAssessment(state, patchBudget, budget)]
    },
    Promise.resolve([]),
  )

  return assessments
}

export const compactReviewServingCandidateSnapshotPatches = async (
  input: {budget?: ReviewServingPatchBudget; candidate: ReviewServingSnapshotManifest},
  database: ReviewServingRetentionServiceDatabase = getReviewServingRetentionDatabase(),
): Promise<ReviewServingCompactionResult> => {
  return database.transaction(async (tx) => {
    const assessments = await assessReviewServingCandidatePatchBudgets(input, tx)
    const compactedComponents = getSupportedPatchCompactions(assessments)

    await compactedComponents.reduce<Promise<void>>(async (previous, assessment) => {
      await previous
      await compactPatchComponent(input.candidate, assessment, tx)
    }, Promise.resolve())

    if (compactedComponents.length > 0) {
      const componentState = getCompactedComponentState(input.candidate.componentState, compactedComponents)

      await tx.run(`
        UPDATE app.review_serving_snapshot_manifest
        SET
          component_state_json = ${getJsonLiteral(componentState as unknown as ReviewServingIdentityValue)},
          composed_identity_json = ${getJsonLiteral(getCompactedComposedIdentity(input.candidate.composedIdentity, componentState))},
          updated_at = current_timestamp
        WHERE project_id = ${getSqlLiteral(input.candidate.projectId)}
          AND snapshot_id = ${getSqlLiteral(input.candidate.snapshotId)}
          AND snapshot_status = 'candidate'
      `)
    }

    return {compactedComponents}
  })
}

export const cleanupReviewServingRetentionState = async (
  input: ReviewServingRetentionCleanupInput,
  database: ReviewServingRetentionServiceDatabase = getReviewServingRetentionDatabase(),
): Promise<ReviewServingRetentionCleanupResult> => {
  return database.transaction(async (tx) => {
    const retentionScope = getRetentionScope(input)
    const retentionState = await getRetentionState(retentionScope, tx)
    const tableIndex = getRetentionCursorIndex(retentionState)
    const allSpecs = [...cleanupTableSpecs, ...patchComponentSpecs]
    const spec = allSpecs[tableIndex % allSpecs.length]

    if (spec !== undefined && 'protectedPredicate' in spec) {
      await deleteCleanupBatch({...input, spec}, tx)
    }

    if (spec !== undefined && 'identityColumn' in spec) {
      await deletePatchTableBatch({...input, spec}, tx)
    }

    await writeRetentionMark(
      {
        baseGeneration: Number(retentionState?.baseGeneration ?? 0),
        cursor: {tableIndex: (tableIndex + 1) % allSpecs.length},
        patchWatermark: Number(retentionState?.patchWatermark ?? 0),
        retentionScope,
        snapshotId: retentionState?.snapshotId ?? null,
      },
      tx,
    )

    return {retentionScope}
  })
}

export const getReviewServingRetentionCleanupTargets = async (
  input: {cleanupBatchSize?: number; now?: Date | string; targetLimit?: number} = {},
  database: ReviewServingRetentionServiceTransaction = getReviewServingRetentionDatabase(),
): Promise<readonly ReviewServingRetentionCleanupInput[]> => {
  const cleanupBatchSize = Math.max(1, Math.floor(input.cleanupBatchSize ?? defaultRetentionCleanupBatchSize))
  const targetLimit = Math.max(1, Math.floor(input.targetLimit ?? defaultRetentionCleanupTargetLimit))
  const now = input.now ?? new Date()
  const rows = await database.queryJson<{projectId: string; reviewConfigHash: string | null}>(`
    SELECT
      project_id AS projectId,
      review_config_hash AS reviewConfigHash
    FROM app.review_serving_snapshot_manifest
    WHERE snapshot_status IN ('active', 'retired', 'failed')
    GROUP BY project_id, review_config_hash
    ORDER BY MAX(updated_at) ASC, project_id ASC, review_config_hash ASC NULLS FIRST
    LIMIT ${getSqlLiteral(targetLimit)}
  `)

  return rows.map((row) => {
    return {batchSize: cleanupBatchSize, now, projectId: row.projectId, reviewConfigHash: row.reviewConfigHash}
  })
}
