type TestDatabase = {run: (statement: string) => Promise<void>}

const escapeSqlString = (value: string) => {
  return value.replaceAll("'", "''")
}

export const seedHumanAssessmentServingArticle = async (params: {
  articleId: string
  database: TestDatabase
  projectId: string
  promptId: string
  snapshotId: string
}) => {
  const {getCurrentReviewConfigHash} = await import('../services/reviewServingProjectConfigIdentity.ts')
  const reviewConfigHash = await getCurrentReviewConfigHash(params.projectId)

  if (!reviewConfigHash) {
    throw new Error('Expected review config hash')
  }

  const requiredComponents = [
    'display',
    'projectScope',
    'selectedImport',
    'payload',
    'judgmentInputContent',
    'llmStatus',
    'queue',
    'summary',
  ]
  const componentState = {
    optional: [],
    required: requiredComponents.map((component) => {
      return {baseGeneration: 1, component, patchWatermark: 0, projectionIdentity: `${params.snapshotId}-${component}`}
    }),
  }

  await params.database.run(`
    INSERT INTO app.review_serving_snapshot_manifest (
      project_id,
      snapshot_id,
      snapshot_status,
      review_config_hash,
      composed_identity_json,
      component_state_json,
      required_components_json,
      optional_components_json,
      source_watermarks_json,
      activated_at
    )
    VALUES (
      '${escapeSqlString(params.projectId)}',
      '${escapeSqlString(params.snapshotId)}',
      'active',
      '${escapeSqlString(reviewConfigHash)}',
      '{}',
      '${escapeSqlString(JSON.stringify(componentState))}'::JSON,
      '${escapeSqlString(JSON.stringify(requiredComponents))}'::JSON,
      '[]',
      '{}',
      current_timestamp
    );

    INSERT INTO mart.review_article_serving_v4 (
      project_id,
      review_config_hash,
      snapshot_id,
      base_generation,
      patch_watermark,
      display_identity,
      project_scope_identity,
      selected_import_identity,
      llm_status_identity,
      human_status_identity,
      posting_identity,
      summary_identity,
      payload_identity,
      list_mode_key,
      article_id,
      sort_key,
      activity_sort_at,
      article_title,
      duplicate_flag,
      conflict_flag,
      llm_judged_prompt_count,
      enabled_prompt_count,
      human_answered_prompt_count,
      review_opened,
      review_sections_completed
    )
    VALUES (
      '${escapeSqlString(params.projectId)}',
      '${escapeSqlString(reviewConfigHash)}',
      '${escapeSqlString(params.snapshotId)}',
      1,
      0,
      '${escapeSqlString(params.snapshotId)}-display',
      '${escapeSqlString(params.snapshotId)}-projectScope',
      '${escapeSqlString(params.snapshotId)}-selectedImport',
      '${escapeSqlString(params.snapshotId)}-llmStatus',
      '${escapeSqlString(params.snapshotId)}-humanStatus',
      '${escapeSqlString(params.snapshotId)}-posting',
      '${escapeSqlString(params.snapshotId)}-summary',
      '${escapeSqlString(params.snapshotId)}-payload',
      'unassessed',
      '${escapeSqlString(params.articleId)}',
      current_timestamp,
      current_timestamp,
      'Human Drift Article',
      FALSE,
      FALSE,
      0,
      1,
      0,
      FALSE,
      0
    );

    INSERT INTO mart.review_unassessed_queue_serving_v4 (
      project_id,
      review_config_hash,
      snapshot_id,
      queue_identity,
      queue_kind,
      priority_bucket,
      activity_sort_at,
      article_id,
      prompt_id
    )
    VALUES (
      '${escapeSqlString(params.projectId)}',
      '${escapeSqlString(reviewConfigHash)}',
      '${escapeSqlString(params.snapshotId)}',
      '${escapeSqlString(params.snapshotId)}-queue',
      'human-unreviewed',
      0,
      current_timestamp,
      '${escapeSqlString(params.articleId)}',
      '${escapeSqlString(params.promptId)}'
    );
  `)
}
