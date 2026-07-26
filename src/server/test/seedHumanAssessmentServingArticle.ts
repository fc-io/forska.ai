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

    INSERT INTO mart.review_article_serving_base_v4 (
      project_id,
      review_config_hash,
      snapshot_id,
      base_generation,
      patch_watermark,
      article_id,
      sort_key,
      activity_sort_at,
      article_created_at
    )
    VALUES (
      '${escapeSqlString(params.projectId)}',
      '${escapeSqlString(reviewConfigHash)}',
      '${escapeSqlString(params.snapshotId)}',
      1,
      0,
      '${escapeSqlString(params.articleId)}',
      current_timestamp,
      current_timestamp,
      current_timestamp
    );

    INSERT INTO mart.review_article_serving_list_mode_state_v4 (
      project_id,
      review_config_hash,
      snapshot_id,
      article_id,
      list_mode_keys,
      llm_patch_watermark,
      human_patch_watermark,
      both_patch_watermark,
      unassessed_patch_watermark
    )
    VALUES (
      '${escapeSqlString(params.projectId)}',
      '${escapeSqlString(reviewConfigHash)}',
      '${escapeSqlString(params.snapshotId)}',
      '${escapeSqlString(params.articleId)}',
      ['unassessed']::VARCHAR[],
      0,
      0,
      0,
      0
    );

    INSERT INTO mart.review_unassessed_queue_serving_v4 (
      project_id,
      review_config_hash,
      snapshot_id,
      queue_kind,
      priority_bucket,
      activity_sort_at,
      article_id,
      prompt_ids,
      queue_updated_at
    )
    VALUES (
      '${escapeSqlString(params.projectId)}',
      '${escapeSqlString(reviewConfigHash)}',
      '${escapeSqlString(params.snapshotId)}',
      'human-unreviewed',
      0,
      current_timestamp,
      '${escapeSqlString(params.articleId)}',
      ['${escapeSqlString(params.promptId)}']::VARCHAR[],
      current_timestamp
    );
  `)
}
