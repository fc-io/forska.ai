import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {withDuckdbMaintenanceAccess} from '../src/server/utils/duckdbScriptAccess.ts'

const judgmentFactBucketCount = 128
const martStageOrder = [
  'project_scope_article',
  'judgment_fact',
  'review_article_judgment_payload',
  'review_article_judgment_detail',
  'review_article_rollup',
  'project_article_ordinal',
  'review_article_candidate',
  'review_article_display',
  'prompt_answer_fact',
  'review_answer_dictionary',
  'review_article_filter_row',
  'review_article_filter_posting',
  'review_article_page',
] as const

type MartStage = (typeof martStageOrder)[number]
type RebuildOptions = {includeArchived: boolean; projectId: string | null; startAt: MartStage}

const getRebuildOptions = (): RebuildOptions => {
  const startAtArg = process.argv.slice(2).find((argument) => {
    return argument.startsWith('--start-at=')
  })
  const projectIdArg = process.argv.slice(2).find((argument) => {
    return argument.startsWith('--project-id=')
  })
  const includeArchived = process.argv.slice(2).includes('--include-archived')
  const startAtValue = (startAtArg?.split('=')[1] ?? 'project_scope_article') as MartStage

  return martStageOrder.includes(startAtValue)
    ? {includeArchived, projectId: projectIdArg?.split('=')[1] ?? null, startAt: startAtValue}
    : {includeArchived, projectId: projectIdArg?.split('=')[1] ?? null, startAt: 'project_scope_article'}
}

const shouldRunStage = (options: RebuildOptions, stage: MartStage) => {
  return martStageOrder.indexOf(stage) >= martStageOrder.indexOf(options.startAt)
}

const quoteSqlString = (value: string) => {
  return `'${value.replaceAll("'", "''")}'`
}

const runSql = async (sql: string) => {
  await getAppDatabaseService().run(sql)
}

const getProjectIds = async (projectId: string | null, includeArchived: boolean) => {
  const whereClause = projectId
    ? `WHERE id = ${quoteSqlString(projectId)}${includeArchived ? '' : ' AND archived = FALSE'}`
    : includeArchived
      ? ''
      : 'WHERE archived = FALSE'

  const rows = await getAppDatabaseService().queryJson<{id: string}>(`
    SELECT id
    FROM app.project
    ${whereClause}
    ORDER BY id ASC
  `)

  return rows.map((row) => {
    return row.id
  })
}

const getMartCounts = async () => {
  const rows = await getAppDatabaseService().queryJson<{count: number; table_name: string}>(`
    SELECT 'mart.project_scope_article' AS table_name, COUNT(*) AS count FROM mart.project_scope_article
    UNION ALL
    SELECT 'mart.judgment_fact' AS table_name, COUNT(*) AS count FROM mart.judgment_fact
    UNION ALL
    SELECT 'mart.review_article_judgment_payload' AS table_name, COUNT(*) AS count FROM mart.review_article_judgment_payload
    UNION ALL
    SELECT 'mart.review_article_judgment_detail' AS table_name, COUNT(*) AS count FROM mart.review_article_judgment_detail
    UNION ALL
    SELECT 'app.project_article_ordinal' AS table_name, COUNT(*) AS count FROM app.project_article_ordinal
    UNION ALL
    SELECT 'mart.review_article_candidate' AS table_name, COUNT(*) AS count FROM mart.review_article_candidate
    UNION ALL
    SELECT 'mart.review_article_display' AS table_name, COUNT(*) AS count FROM mart.review_article_display
    UNION ALL
    SELECT 'mart.prompt_answer_fact' AS table_name, COUNT(*) AS count FROM mart.prompt_answer_fact
    UNION ALL
    SELECT 'app.review_answer_dictionary' AS table_name, COUNT(*) AS count FROM app.review_answer_dictionary
    UNION ALL
    SELECT 'mart.review_article_filter_row' AS table_name, COUNT(*) AS count FROM mart.review_article_filter_row
    UNION ALL
    SELECT 'mart.review_article_filter_posting' AS table_name, COUNT(*) AS count FROM mart.review_article_filter_posting
    UNION ALL
    SELECT 'mart.review_article_rollup' AS table_name, COUNT(*) AS count FROM mart.review_article_rollup
    UNION ALL
    SELECT 'mart.review_article_page' AS table_name, COUNT(*) AS count FROM mart.review_article_page
  `)

  return rows
}

const getProjectScopeArticleSql = (projectId: string) => {
  const projectLiteral = quoteSqlString(projectId)

  return `
    BEGIN TRANSACTION;
    DELETE FROM mart.project_scope_article WHERE project_id = ${projectLiteral};
    INSERT INTO mart.project_scope_article (
      project_id,
      article_id,
      in_curated_scope,
      in_route_scope,
      matched_import_route_ids,
      article_title,
      article_created_at,
      article_updated_at,
      article_import_route,
      article_publication_status,
      source_updated_at
    )
    WITH route_scope AS (
      SELECT
        pir.project_id,
        air.article_id,
        air.import_route_id,
        TRUE AS in_route_scope,
        FALSE AS in_curated_scope
      FROM app.project_import_route pir
      INNER JOIN app.article_import_route air ON air.import_route_id = pir.import_route_id
      WHERE pir.project_id = ${projectLiteral}
    ),
    curated_scope AS (
      SELECT
        pa.project_id,
        pa.article_id,
        NULL AS import_route_id,
        FALSE AS in_route_scope,
        TRUE AS in_curated_scope
      FROM app.project_article pa
      WHERE pa.project_id = ${projectLiteral}
    ),
    combined_scope AS (
      SELECT * FROM route_scope
      UNION ALL
      SELECT * FROM curated_scope
    ),
    aggregated_scope AS (
      SELECT
        project_id,
        article_id,
        COALESCE(BOOL_OR(in_curated_scope), FALSE) AS in_curated_scope,
        COALESCE(BOOL_OR(in_route_scope), FALSE) AS in_route_scope,
        LIST(DISTINCT import_route_id) FILTER (WHERE import_route_id IS NOT NULL) AS matched_import_route_ids
      FROM combined_scope
      GROUP BY project_id, article_id
    )
    SELECT
      aggregated_scope.project_id,
      aggregated_scope.article_id,
      aggregated_scope.in_curated_scope,
      aggregated_scope.in_route_scope,
      aggregated_scope.matched_import_route_ids,
      article.article_title,
      article.article_created_at,
      article.article_updated_at,
      article.import_route,
      article.publication_status,
      article.updated_at
    FROM aggregated_scope
    INNER JOIN app.project project
      ON project.id = aggregated_scope.project_id
     AND project.archived = FALSE
    INNER JOIN app.article article ON article.id = aggregated_scope.article_id;
    COMMIT;
  `
}

const getJudgmentFactSql = (bucketNumber: number) => {
  return `
    BEGIN TRANSACTION;
    DELETE FROM mart.judgment_fact WHERE HASH(judgment_id) % ${String(judgmentFactBucketCount)} = ${String(bucketNumber)};
    INSERT INTO mart.judgment_fact (
      judgment_id,
      article_id,
      prompt_id,
      model_id,
      project_id,
      snapshot_project_id,
      snapshot_project_model_name,
      use_title,
      use_abstract,
      use_fulltext,
      use_fulltext_no_images,
      chunking_strategy,
      is_answered,
      answered_original,
      answered_original_as_array,
      normalized_answers,
      confidence_original,
      explanation,
      quotes,
      article_title,
      article_created_at,
      article_updated_at,
      article_import_route,
      article_publication_status,
      created_at,
      updated_at
    )
    SELECT
      judgment.id,
      judgment.article_id,
      judgment.prompt_id,
      judgment.model_id,
      judgment.project_id,
      judgment.snapshot_project_id,
      judgment.snapshot_project_model_name,
      judgment.use_title,
      judgment.use_abstract,
      judgment.use_fulltext,
      judgment.use_fulltext_no_images,
      judgment.chunking_strategy,
      judgment.is_answered,
      NULLIF(TRIM(COALESCE(judgment.answered_original, '')), '') AS answered_original,
      judgment.answered_original_as_array,
      CASE
        WHEN judgment.answered_original_as_array IS NOT NULL AND ARRAY_LENGTH(judgment.answered_original_as_array) > 0
          THEN judgment.answered_original_as_array
        WHEN NULLIF(TRIM(COALESCE(judgment.answered_original, '')), '') IS NOT NULL
          THEN [TRIM(COALESCE(judgment.answered_original, ''))]
        ELSE NULL
      END AS normalized_answers,
      judgment.confidence_original,
      judgment.explanation,
      judgment.quotes,
      article.article_title,
      article.article_created_at,
      article.article_updated_at,
      article.import_route,
      article.publication_status,
      judgment.created_at,
      judgment.updated_at
    FROM app.judgment judgment
    INNER JOIN app.article article ON article.id = judgment.article_id
    WHERE judgment.deleted_at IS NULL
      AND HASH(judgment.id) % ${String(judgmentFactBucketCount)} = ${String(bucketNumber)};
    COMMIT;
  `
}

const getPromptAnswerFactSql = (projectId: string) => {
  const projectLiteral = quoteSqlString(projectId)

  return `
    BEGIN TRANSACTION;
    DELETE FROM mart.prompt_answer_fact WHERE project_id = ${projectLiteral};
    INSERT INTO mart.prompt_answer_fact (
      project_id,
      article_id,
      prompt_id,
      judgment_id,
      model_id,
      answer_value,
      answered_original,
      article_title,
      article_created_at,
      article_updated_at,
      judgment_created_at
    )
    WITH eligible_project_judgment AS (
      SELECT
        scope_article.project_id,
        judgment_fact.article_id,
        judgment_fact.prompt_id,
        judgment_fact.judgment_id,
        judgment_fact.model_id,
        judgment_fact.answered_original,
        judgment_fact.normalized_answers,
        judgment_fact.article_title,
        judgment_fact.article_created_at,
        judgment_fact.article_updated_at,
        judgment_fact.created_at AS judgment_created_at
      FROM mart.project_scope_article scope_article
      INNER JOIN app.project project ON project.id = scope_article.project_id
      INNER JOIN app.project_prompt project_prompt
        ON project_prompt.project_id = scope_article.project_id
       AND project_prompt.enabled = TRUE
      INNER JOIN mart.judgment_fact judgment_fact
        ON judgment_fact.article_id = scope_article.article_id
       AND judgment_fact.prompt_id = project_prompt.prompt_id
       AND judgment_fact.model_id = project.model_id
       AND judgment_fact.use_title = project.use_title
       AND judgment_fact.use_abstract = project.use_abstract
       AND judgment_fact.use_fulltext = project.use_fulltext
       AND judgment_fact.use_fulltext_no_images = project.use_fulltext_no_images
      WHERE scope_article.project_id = ${projectLiteral}
    )
    SELECT DISTINCT
      eligible_project_judgment.project_id,
      eligible_project_judgment.article_id,
      eligible_project_judgment.prompt_id,
      eligible_project_judgment.judgment_id,
      eligible_project_judgment.model_id,
      TRIM(answer.answer_value) AS answer_value,
      eligible_project_judgment.answered_original,
      eligible_project_judgment.article_title,
      eligible_project_judgment.article_created_at,
      eligible_project_judgment.article_updated_at,
      eligible_project_judgment.judgment_created_at
    FROM eligible_project_judgment,
      UNNEST(eligible_project_judgment.normalized_answers) AS answer(answer_value)
    WHERE eligible_project_judgment.normalized_answers IS NOT NULL
      AND ARRAY_LENGTH(eligible_project_judgment.normalized_answers) > 0
      AND NULLIF(TRIM(answer.answer_value), '') IS NOT NULL;
    COMMIT;
  `
}

const getReviewArticleJudgmentDetailSql = (projectId: string) => {
  const projectLiteral = quoteSqlString(projectId)

  return `
    BEGIN TRANSACTION;
    DELETE FROM mart.review_article_judgment_detail WHERE project_id = ${projectLiteral};
    INSERT INTO mart.review_article_judgment_detail (
      project_id,
      article_id,
      prompt_id,
      prompt_order,
      judgment_id,
      created_at,
      article_title,
      article_created_at,
      article_updated_at,
      article_import_route,
      model_id,
      answered_original,
      answered_original_as_array
    )
    SELECT
      scope_article.project_id,
      judgment_fact.article_id,
      judgment_fact.prompt_id,
      project_prompt.prompt_order,
      judgment_fact.judgment_id,
      judgment_fact.created_at,
      judgment_fact.article_title,
      judgment_fact.article_created_at,
      judgment_fact.article_updated_at,
      judgment_fact.article_import_route,
      judgment_fact.model_id,
      judgment_fact.answered_original,
      judgment_fact.answered_original_as_array
    FROM mart.project_scope_article scope_article
    INNER JOIN app.project project ON project.id = scope_article.project_id
    INNER JOIN app.project_prompt project_prompt
      ON project_prompt.project_id = scope_article.project_id
     AND project_prompt.enabled = TRUE
    INNER JOIN mart.judgment_fact judgment_fact
      ON judgment_fact.article_id = scope_article.article_id
     AND judgment_fact.prompt_id = project_prompt.prompt_id
     AND judgment_fact.model_id = project.model_id
     AND judgment_fact.use_title = project.use_title
     AND judgment_fact.use_abstract = project.use_abstract
     AND judgment_fact.use_fulltext = project.use_fulltext
     AND judgment_fact.use_fulltext_no_images = project.use_fulltext_no_images
    WHERE scope_article.project_id = ${projectLiteral};
    COMMIT;
  `
}

const getReviewArticleJudgmentPayloadSql = (projectId: string) => {
  const projectLiteral = quoteSqlString(projectId)

  return `
    BEGIN TRANSACTION;
    DELETE FROM mart.review_article_judgment_payload WHERE project_id = ${projectLiteral};
    INSERT INTO mart.review_article_judgment_payload (
      project_id,
      judgment_id,
      explanation,
      quotes,
      payload_updated_at
    )
    SELECT
      scope_article.project_id,
      judgment_fact.judgment_id,
      judgment_fact.explanation,
      judgment_fact.quotes,
      current_timestamp
    FROM mart.project_scope_article scope_article
    INNER JOIN app.project project ON project.id = scope_article.project_id
    INNER JOIN app.project_prompt project_prompt
      ON project_prompt.project_id = scope_article.project_id
     AND project_prompt.enabled = TRUE
    INNER JOIN mart.judgment_fact judgment_fact
      ON judgment_fact.article_id = scope_article.article_id
     AND judgment_fact.prompt_id = project_prompt.prompt_id
     AND judgment_fact.model_id = project.model_id
     AND judgment_fact.use_title = project.use_title
     AND judgment_fact.use_abstract = project.use_abstract
     AND judgment_fact.use_fulltext = project.use_fulltext
     AND judgment_fact.use_fulltext_no_images = project.use_fulltext_no_images
    WHERE scope_article.project_id = ${projectLiteral};
    COMMIT;
  `
}

const getProjectArticleOrdinalSql = (projectId: string) => {
  const projectLiteral = quoteSqlString(projectId)

  return `
    BEGIN TRANSACTION;
    DELETE FROM app.project_article_ordinal WHERE project_id = ${projectLiteral};
    INSERT INTO app.project_article_ordinal (
      project_id,
      article_id,
      article_seq,
      ordinal_updated_at
    )
    SELECT
      project_id,
      article_id,
      ROW_NUMBER() OVER (ORDER BY article_created_at DESC NULLS LAST, article_id ASC) AS article_seq,
      current_timestamp
    FROM mart.review_article_rollup
    WHERE project_id = ${projectLiteral};
    COMMIT;
  `
}

const getReviewArticleCandidateSql = (projectId: string) => {
  const projectLiteral = quoteSqlString(projectId)

  return `
    BEGIN TRANSACTION;
    DELETE FROM mart.review_article_candidate WHERE project_id = ${projectLiteral};
    INSERT INTO mart.review_article_candidate (
      project_id,
      article_id,
      article_seq,
      article_created_at,
      article_updated_at,
      article_title,
      has_all_llm_judgments,
      llm_judged_prompt_count,
      enabled_prompt_count,
      candidate_updated_at
    )
    SELECT
      rollup.project_id,
      rollup.article_id,
      ordinal.article_seq,
      rollup.article_created_at,
      rollup.article_updated_at,
      rollup.article_title,
      rollup.has_all_llm_judgments,
      rollup.llm_judged_prompt_count,
      rollup.enabled_prompt_count,
      current_timestamp
    FROM mart.review_article_rollup rollup
    INNER JOIN app.project_article_ordinal ordinal
      ON ordinal.project_id = rollup.project_id
     AND ordinal.article_id = rollup.article_id
    WHERE rollup.project_id = ${projectLiteral};
    COMMIT;
  `
}

const getReviewArticleDisplaySql = (projectId: string) => {
  const projectLiteral = quoteSqlString(projectId)

  return `
    BEGIN TRANSACTION;
    DELETE FROM mart.review_article_display WHERE project_id = ${projectLiteral};
    INSERT INTO mart.review_article_display (
      project_id,
      article_id,
      article_external_id,
      article_title,
      journal_title,
      url,
      full_text_pdf,
      full_text_fetched_at,
      full_text_conversion_status,
      display_updated_at
    )
    SELECT
      rollup.project_id,
      rollup.article_id,
      article.article_id,
      rollup.article_title,
      NULL,
      article.url,
      article.full_text_pdf,
      article.full_text_fetched_at,
      article.full_text_conversion_status,
      current_timestamp
    FROM mart.review_article_rollup rollup
    INNER JOIN app.article article ON article.id = rollup.article_id
    WHERE rollup.project_id = ${projectLiteral};
    COMMIT;
  `
}

const getReviewAnswerDictionarySql = (projectId: string) => {
  const projectLiteral = quoteSqlString(projectId)

  return `
    BEGIN TRANSACTION;
    DELETE FROM app.review_answer_dictionary WHERE project_id = ${projectLiteral};
    INSERT INTO app.review_answer_dictionary (
      project_id,
      prompt_id,
      answer_id,
      answer_value,
      numeric_answer_value,
      dictionary_updated_at
    )
    SELECT
      project_id,
      prompt_id,
      DENSE_RANK() OVER (PARTITION BY project_id, prompt_id ORDER BY answer_value ASC) AS answer_id,
      answer_value,
      TRY_CAST(answer_value AS BIGINT),
      current_timestamp
    FROM (
      SELECT DISTINCT project_id, prompt_id, answer_value
      FROM mart.prompt_answer_fact
      WHERE project_id = ${projectLiteral}
    ) answer_values;
    COMMIT;
  `
}

const getReviewArticleFilterPostingSql = (projectId: string) => {
  const projectLiteral = quoteSqlString(projectId)

  return `
    BEGIN TRANSACTION;
    DELETE FROM mart.review_article_filter_posting WHERE project_id = ${projectLiteral};
    INSERT INTO mart.review_article_filter_posting (
      project_id,
      prompt_id,
      answer_id,
      article_seq_list,
      article_count,
      posting_updated_at
    )
    SELECT
      fact.project_id,
      fact.prompt_id,
      dict.answer_id,
      LIST(ordinal.article_seq ORDER BY ordinal.article_seq ASC) AS article_seq_list,
      COUNT(*) AS article_count,
      current_timestamp
    FROM mart.prompt_answer_fact fact
    INNER JOIN app.review_answer_dictionary dict
      ON dict.project_id = fact.project_id
     AND dict.prompt_id = fact.prompt_id
     AND dict.answer_value = fact.answer_value
    INNER JOIN app.project_article_ordinal ordinal
      ON ordinal.project_id = fact.project_id
     AND ordinal.article_id = fact.article_id
    WHERE fact.project_id = ${projectLiteral}
    GROUP BY fact.project_id, fact.prompt_id, dict.answer_id;
    COMMIT;
  `
}

const getReviewArticleFilterRowSql = (projectId: string) => {
  const projectLiteral = quoteSqlString(projectId)

  return `
    BEGIN TRANSACTION;
    DELETE FROM mart.review_article_filter_row WHERE project_id = ${projectLiteral};
    INSERT INTO mart.review_article_filter_row (
      project_id,
      article_id,
      prompt_id,
      answer_value,
      numeric_answer_value,
      filter_updated_at
    )
    SELECT
      project_id,
      article_id,
      prompt_id,
      answer_value,
      TRY_CAST(answer_value AS BIGINT),
      current_timestamp
    FROM mart.prompt_answer_fact
    WHERE project_id = ${projectLiteral};
    COMMIT;
  `
}

const getReviewArticleRollupSql = (projectId: string) => {
  const projectLiteral = quoteSqlString(projectId)

  return `
    BEGIN TRANSACTION;
    DELETE FROM mart.review_article_rollup WHERE project_id = ${projectLiteral};
    INSERT INTO mart.review_article_rollup (
      project_id,
      article_id,
      article_title,
      article_created_at,
      article_updated_at,
      article_import_route,
      article_publication_status,
      matched_import_route_ids,
      enabled_prompt_count,
      llm_judged_prompt_count,
      human_answered_prompt_count,
      llm_judged_prompt_ids,
      human_answered_prompt_ids,
      has_all_llm_judgments,
      has_all_human_answers,
      in_curated_scope,
      in_route_scope,
      review_opened,
      review_sections_completed,
      latest_llm_created_at,
      latest_human_updated_at,
      latest_review_updated_at,
      rollup_updated_at
    )
    WITH enabled_project_prompt AS (
      SELECT project_id, prompt_id
      FROM app.project_prompt
      WHERE enabled = TRUE AND project_id = ${projectLiteral}
    ),
    enabled_project_prompt_count AS (
      SELECT project_id, COUNT(*) AS enabled_prompt_count
      FROM enabled_project_prompt
      GROUP BY project_id
    ),
    llm_project_prompt AS (
      SELECT
        scope_article.project_id,
        judgment_fact.article_id,
        judgment_fact.prompt_id,
        MAX(judgment_fact.created_at) AS latest_llm_created_at
      FROM mart.project_scope_article scope_article
      INNER JOIN app.project project ON project.id = scope_article.project_id
      INNER JOIN enabled_project_prompt enabled_prompt
        ON enabled_prompt.project_id = scope_article.project_id
      INNER JOIN mart.judgment_fact judgment_fact
        ON judgment_fact.article_id = scope_article.article_id
       AND judgment_fact.prompt_id = enabled_prompt.prompt_id
       AND judgment_fact.model_id = project.model_id
       AND judgment_fact.use_title = project.use_title
       AND judgment_fact.use_abstract = project.use_abstract
       AND judgment_fact.use_fulltext = project.use_fulltext
       AND judgment_fact.use_fulltext_no_images = project.use_fulltext_no_images
      WHERE scope_article.project_id = ${projectLiteral}
      GROUP BY scope_article.project_id, judgment_fact.article_id, judgment_fact.prompt_id
    ),
    llm_project_rollup AS (
      SELECT
        project_id,
        article_id,
        COUNT(DISTINCT prompt_id) AS llm_judged_prompt_count,
        LIST(DISTINCT prompt_id) AS llm_judged_prompt_ids,
        MAX(latest_llm_created_at) AS latest_llm_created_at
      FROM llm_project_prompt
      GROUP BY project_id, article_id
    ),
    human_project_prompt AS (
      SELECT
        judgment_human.project_id,
        judgment_human.article_id,
        judgment_human.prompt_id,
        MAX(judgment_human.updated_at) AS latest_human_updated_at
      FROM app.judgment_human judgment_human
      INNER JOIN enabled_project_prompt enabled_prompt
        ON enabled_prompt.project_id = judgment_human.project_id
       AND enabled_prompt.prompt_id = judgment_human.prompt_id
      WHERE judgment_human.project_id = ${projectLiteral}
        AND judgment_human.is_answered = TRUE
        AND NULLIF(TRIM(COALESCE(judgment_human.answer, '')), '') IS NOT NULL
      GROUP BY judgment_human.project_id, judgment_human.article_id, judgment_human.prompt_id
    ),
    human_project_rollup AS (
      SELECT
        project_id,
        article_id,
        COUNT(DISTINCT prompt_id) AS human_answered_prompt_count,
        LIST(DISTINCT prompt_id) AS human_answered_prompt_ids,
        MAX(latest_human_updated_at) AS latest_human_updated_at
      FROM human_project_prompt
      GROUP BY project_id, article_id
    ),
    review_state AS (
      SELECT
        review.project_id,
        review.article_id,
        MAX(review.updated_at) AS latest_review_updated_at,
        COALESCE(BOOL_OR(review.opened), FALSE) AS review_opened,
        MAX(
          CAST(review.reviewed_title AS INTEGER)
          + CAST(review.reviewed_abstract AS INTEGER)
          + CAST(review.reviewed_intro AS INTEGER)
          + CAST(review.reviewed_method AS INTEGER)
          + CAST(review.reviewed_results AS INTEGER)
          + CAST(review.reviewed_discussion AS INTEGER)
          + CAST(review.reviewed_conclusion AS INTEGER)
          + CAST(review.reviewed_appendix AS INTEGER)
          + CAST(review.reviewed_other AS INTEGER)
        ) AS review_sections_completed
      FROM app.review review
      WHERE review.project_id = ${projectLiteral}
      GROUP BY review.project_id, review.article_id
    )
    SELECT
      scope_article.project_id,
      scope_article.article_id,
      scope_article.article_title,
      scope_article.article_created_at,
      scope_article.article_updated_at,
      scope_article.article_import_route,
      scope_article.article_publication_status,
      scope_article.matched_import_route_ids,
      COALESCE(prompt_count.enabled_prompt_count, 0) AS enabled_prompt_count,
      COALESCE(llm_rollup.llm_judged_prompt_count, 0) AS llm_judged_prompt_count,
      COALESCE(human_rollup.human_answered_prompt_count, 0) AS human_answered_prompt_count,
      llm_rollup.llm_judged_prompt_ids,
      human_rollup.human_answered_prompt_ids,
      COALESCE(prompt_count.enabled_prompt_count, 0) > 0
        AND COALESCE(llm_rollup.llm_judged_prompt_count, 0) = COALESCE(prompt_count.enabled_prompt_count, 0) AS has_all_llm_judgments,
      COALESCE(prompt_count.enabled_prompt_count, 0) > 0
        AND COALESCE(human_rollup.human_answered_prompt_count, 0) = COALESCE(prompt_count.enabled_prompt_count, 0) AS has_all_human_answers,
      scope_article.in_curated_scope,
      scope_article.in_route_scope,
      COALESCE(review_state.review_opened, FALSE) AS review_opened,
      COALESCE(review_state.review_sections_completed, 0) AS review_sections_completed,
      llm_rollup.latest_llm_created_at,
      human_rollup.latest_human_updated_at,
      review_state.latest_review_updated_at,
      current_timestamp AS rollup_updated_at
    FROM mart.project_scope_article scope_article
    LEFT JOIN enabled_project_prompt_count prompt_count ON prompt_count.project_id = scope_article.project_id
    LEFT JOIN llm_project_rollup llm_rollup
      ON llm_rollup.project_id = scope_article.project_id
     AND llm_rollup.article_id = scope_article.article_id
    LEFT JOIN human_project_rollup human_rollup
      ON human_rollup.project_id = scope_article.project_id
     AND human_rollup.article_id = scope_article.article_id
    LEFT JOIN review_state
      ON review_state.project_id = scope_article.project_id
     AND review_state.article_id = scope_article.article_id
    WHERE scope_article.project_id = ${projectLiteral};
    COMMIT;
  `
}

const getReviewArticlePageSql = (projectId: string) => {
  const projectLiteral = quoteSqlString(projectId)

  return `
    BEGIN TRANSACTION;
    DELETE FROM mart.review_article_page WHERE project_id = ${projectLiteral};
    INSERT INTO mart.review_article_page (
      project_id,
      article_id,
      article_created_at,
      article_updated_at,
      article_title,
      journal_title,
      has_all_llm_judgments,
      llm_judged_prompt_count,
      enabled_prompt_count,
      page_updated_at
    )
    SELECT
      rollup.project_id,
      rollup.article_id,
      rollup.article_created_at,
      rollup.article_updated_at,
      rollup.article_title,
      NULL,
      rollup.has_all_llm_judgments,
      rollup.llm_judged_prompt_count,
      rollup.enabled_prompt_count,
      current_timestamp
    FROM mart.review_article_rollup rollup
    WHERE rollup.project_id = ${projectLiteral};
    COMMIT;
  `
}

const rebuildProjectScopeArticleProjects = async (projectIds: string[], index = 0): Promise<void> => {
  if (index >= projectIds.length) {
    return
  }

  const projectId = projectIds[index]

  if (!projectId) {
    return rebuildProjectScopeArticleProjects(projectIds, index + 1)
  }

  if (index % 10 === 0) {
    console.log(`rebuilding mart.project_scope_article project ${index + 1}/${projectIds.length}`)
  }

  await runSql(getProjectScopeArticleSql(projectId))
  return rebuildProjectScopeArticleProjects(projectIds, index + 1)
}

const rebuildJudgmentFactBuckets = async (bucketNumber = 0): Promise<void> => {
  if (bucketNumber >= judgmentFactBucketCount) {
    return
  }

  if (bucketNumber % 8 === 0) {
    console.log(`rebuilding mart.judgment_fact bucket ${bucketNumber + 1}/${judgmentFactBucketCount}`)
  }

  await runSql(getJudgmentFactSql(bucketNumber))
  return rebuildJudgmentFactBuckets(bucketNumber + 1)
}

const rebuildPromptAnswerFactProjects = async (projectIds: string[], index = 0): Promise<void> => {
  if (index >= projectIds.length) {
    return
  }

  const projectId = projectIds[index]

  if (!projectId) {
    return rebuildPromptAnswerFactProjects(projectIds, index + 1)
  }

  if (index % 10 === 0) {
    console.log(`rebuilding mart.prompt_answer_fact project ${index + 1}/${projectIds.length}`)
  }

  await runSql(getPromptAnswerFactSql(projectId))
  return rebuildPromptAnswerFactProjects(projectIds, index + 1)
}

const rebuildReviewArticleJudgmentPayloadProjects = async (projectIds: string[], index = 0): Promise<void> => {
  if (index >= projectIds.length) {
    return
  }

  const projectId = projectIds[index]

  if (!projectId) {
    return rebuildReviewArticleJudgmentPayloadProjects(projectIds, index + 1)
  }

  if (index % 10 === 0) {
    console.log(`rebuilding mart.review_article_judgment_payload project ${index + 1}/${projectIds.length}`)
  }

  await runSql(getReviewArticleJudgmentPayloadSql(projectId))
  return rebuildReviewArticleJudgmentPayloadProjects(projectIds, index + 1)
}

const rebuildProjectArticleOrdinalProjects = async (projectIds: string[], index = 0): Promise<void> => {
  if (index >= projectIds.length) {
    return
  }

  const projectId = projectIds[index]

  if (!projectId) {
    return rebuildProjectArticleOrdinalProjects(projectIds, index + 1)
  }

  if (index % 10 === 0) {
    console.log(`rebuilding app.project_article_ordinal project ${index + 1}/${projectIds.length}`)
  }

  await runSql(getProjectArticleOrdinalSql(projectId))
  return rebuildProjectArticleOrdinalProjects(projectIds, index + 1)
}

const rebuildReviewArticleCandidateProjects = async (projectIds: string[], index = 0): Promise<void> => {
  if (index >= projectIds.length) {
    return
  }

  const projectId = projectIds[index]

  if (!projectId) {
    return rebuildReviewArticleCandidateProjects(projectIds, index + 1)
  }

  if (index % 10 === 0) {
    console.log(`rebuilding mart.review_article_candidate project ${index + 1}/${projectIds.length}`)
  }

  await runSql(getReviewArticleCandidateSql(projectId))
  return rebuildReviewArticleCandidateProjects(projectIds, index + 1)
}

const rebuildReviewArticleDisplayProjects = async (projectIds: string[], index = 0): Promise<void> => {
  if (index >= projectIds.length) {
    return
  }

  const projectId = projectIds[index]

  if (!projectId) {
    return rebuildReviewArticleDisplayProjects(projectIds, index + 1)
  }

  if (index % 10 === 0) {
    console.log(`rebuilding mart.review_article_display project ${index + 1}/${projectIds.length}`)
  }

  await runSql(getReviewArticleDisplaySql(projectId))
  return rebuildReviewArticleDisplayProjects(projectIds, index + 1)
}

const rebuildReviewAnswerDictionaryProjects = async (projectIds: string[], index = 0): Promise<void> => {
  if (index >= projectIds.length) {
    return
  }

  const projectId = projectIds[index]

  if (!projectId) {
    return rebuildReviewAnswerDictionaryProjects(projectIds, index + 1)
  }

  if (index % 10 === 0) {
    console.log(`rebuilding app.review_answer_dictionary project ${index + 1}/${projectIds.length}`)
  }

  await runSql(getReviewAnswerDictionarySql(projectId))
  return rebuildReviewAnswerDictionaryProjects(projectIds, index + 1)
}

const rebuildReviewArticleFilterPostingProjects = async (projectIds: string[], index = 0): Promise<void> => {
  if (index >= projectIds.length) {
    return
  }

  const projectId = projectIds[index]

  if (!projectId) {
    return rebuildReviewArticleFilterPostingProjects(projectIds, index + 1)
  }

  if (index % 10 === 0) {
    console.log(`rebuilding mart.review_article_filter_posting project ${index + 1}/${projectIds.length}`)
  }

  await runSql(getReviewArticleFilterPostingSql(projectId))
  return rebuildReviewArticleFilterPostingProjects(projectIds, index + 1)
}

const rebuildReviewArticleJudgmentDetailProjects = async (projectIds: string[], index = 0): Promise<void> => {
  if (index >= projectIds.length) {
    return
  }

  const projectId = projectIds[index]

  if (!projectId) {
    return rebuildReviewArticleJudgmentDetailProjects(projectIds, index + 1)
  }

  if (index % 10 === 0) {
    console.log(`rebuilding mart.review_article_judgment_detail project ${index + 1}/${projectIds.length}`)
  }

  await runSql(getReviewArticleJudgmentDetailSql(projectId))
  return rebuildReviewArticleJudgmentDetailProjects(projectIds, index + 1)
}

const rebuildReviewArticleFilterRowProjects = async (projectIds: string[], index = 0): Promise<void> => {
  if (index >= projectIds.length) {
    return
  }

  const projectId = projectIds[index]

  if (!projectId) {
    return rebuildReviewArticleFilterRowProjects(projectIds, index + 1)
  }

  if (index % 10 === 0) {
    console.log(`rebuilding mart.review_article_filter_row project ${index + 1}/${projectIds.length}`)
  }

  await runSql(getReviewArticleFilterRowSql(projectId))
  return rebuildReviewArticleFilterRowProjects(projectIds, index + 1)
}

const rebuildReviewArticleRollupProjects = async (projectIds: string[], index = 0): Promise<void> => {
  if (index >= projectIds.length) {
    return
  }

  const projectId = projectIds[index]

  if (!projectId) {
    return rebuildReviewArticleRollupProjects(projectIds, index + 1)
  }

  if (index % 10 === 0) {
    console.log(`rebuilding mart.review_article_rollup project ${index + 1}/${projectIds.length}`)
  }

  await runSql(getReviewArticleRollupSql(projectId))
  return rebuildReviewArticleRollupProjects(projectIds, index + 1)
}

const rebuildReviewArticlePageProjects = async (projectIds: string[], index = 0): Promise<void> => {
  if (index >= projectIds.length) {
    return
  }

  const projectId = projectIds[index]

  if (!projectId) {
    return rebuildReviewArticlePageProjects(projectIds, index + 1)
  }

  if (index % 10 === 0) {
    console.log(`rebuilding mart.review_article_page project ${index + 1}/${projectIds.length}`)
  }

  await runSql(getReviewArticlePageSql(projectId))
  return rebuildReviewArticlePageProjects(projectIds, index + 1)
}

const rebuildDuckdbMarts = async (options: RebuildOptions) => {
  const projectIds = await getProjectIds(options.projectId, options.includeArchived)

  await runSql('SET threads = 1')
  await runSql('SET preserve_insertion_order = false')

  if (shouldRunStage(options, 'project_scope_article')) {
    console.log('starting mart.project_scope_article rebuild')
    await rebuildProjectScopeArticleProjects(projectIds)
    console.log(JSON.stringify(await getMartCounts()))
  }

  if (shouldRunStage(options, 'judgment_fact')) {
    console.log('starting mart.judgment_fact rebuild')
    await rebuildJudgmentFactBuckets()
    console.log(JSON.stringify(await getMartCounts()))
  }

  if (shouldRunStage(options, 'review_article_judgment_payload')) {
    console.log('starting mart.review_article_judgment_payload rebuild')
    await rebuildReviewArticleJudgmentPayloadProjects(projectIds)
    console.log(JSON.stringify(await getMartCounts()))
  }

  if (shouldRunStage(options, 'review_article_judgment_detail')) {
    console.log('starting mart.review_article_judgment_detail rebuild')
    await rebuildReviewArticleJudgmentDetailProjects(projectIds)
    console.log(JSON.stringify(await getMartCounts()))
  }

  if (shouldRunStage(options, 'review_article_rollup')) {
    console.log('starting mart.review_article_rollup rebuild')
    await rebuildReviewArticleRollupProjects(projectIds)
    console.log(JSON.stringify(await getMartCounts()))
  }

  if (shouldRunStage(options, 'project_article_ordinal')) {
    console.log('starting app.project_article_ordinal rebuild')
    await rebuildProjectArticleOrdinalProjects(projectIds)
    console.log(JSON.stringify(await getMartCounts()))
  }

  if (shouldRunStage(options, 'review_article_candidate')) {
    console.log('starting mart.review_article_candidate rebuild')
    await rebuildReviewArticleCandidateProjects(projectIds)
    console.log(JSON.stringify(await getMartCounts()))
  }

  if (shouldRunStage(options, 'review_article_display')) {
    console.log('starting mart.review_article_display rebuild')
    await rebuildReviewArticleDisplayProjects(projectIds)
    console.log(JSON.stringify(await getMartCounts()))
  }

  if (shouldRunStage(options, 'prompt_answer_fact')) {
    console.log('starting mart.prompt_answer_fact rebuild')
    await rebuildPromptAnswerFactProjects(projectIds)
    console.log(JSON.stringify(await getMartCounts()))
  }

  if (shouldRunStage(options, 'review_answer_dictionary')) {
    console.log('starting app.review_answer_dictionary rebuild')
    await rebuildReviewAnswerDictionaryProjects(projectIds)
    console.log(JSON.stringify(await getMartCounts()))
  }

  if (shouldRunStage(options, 'review_article_filter_row')) {
    console.log('starting mart.review_article_filter_row rebuild')
    await rebuildReviewArticleFilterRowProjects(projectIds)
    console.log(JSON.stringify(await getMartCounts()))
  }

  if (shouldRunStage(options, 'review_article_filter_posting')) {
    console.log('starting mart.review_article_filter_posting rebuild')
    await rebuildReviewArticleFilterPostingProjects(projectIds)
    console.log(JSON.stringify(await getMartCounts()))
  }

  if (shouldRunStage(options, 'review_article_page')) {
    console.log('starting mart.review_article_page rebuild')
    await rebuildReviewArticlePageProjects(projectIds)
    console.log(JSON.stringify(await getMartCounts()))
  }
}

const main = async () => {
  await withDuckdbMaintenanceAccess('duckdb mart rebuild', async () => {
    await rebuildDuckdbMarts(getRebuildOptions())
    await getAppDatabaseService().close()
  })
}

void main()
