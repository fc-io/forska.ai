import {randomUUID} from 'node:crypto'

import {getAppDatabaseService} from './appDatabaseService.ts'
import {getQuotedStringList, getSqlLiteral} from './appQueryHelpers.ts'

type MartRefreshScope = 'judgment_article' | 'project'

type MartRefreshTaskRow = {
  articleId: string | null
  id: string
  projectId: string | null
  refreshScope: MartRefreshScope
}

type QueueMartRefreshTask = {
  articleId?: string | null
  projectId?: string | null
  reason: string
  refreshScope: MartRefreshScope
}

let martRefreshDrainPromise: Promise<void> | null = null
let martRefreshDrainTimer: ReturnType<typeof setTimeout> | null = null

const martRefreshBatchLimit = 256
const martRefreshRetryDelayMs = 5000
const martRefreshScheduleDelayMs = 250

const getProjectRefreshSql = (projectId: string) => {
  const projectLiteral = getSqlLiteral(projectId)

  return [
    `
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
      INNER JOIN app.article article ON article.id = aggregated_scope.article_id;
      COMMIT;
    `,
    `
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
    `,
    `
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
    `,
  ]
}

const getJudgmentArticleRefreshSql = (articleId: string) => {
  const articleLiteral = getSqlLiteral(articleId)

  return `
    BEGIN TRANSACTION;
    DELETE FROM mart.judgment_fact WHERE article_id = ${articleLiteral};
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
      AND judgment.article_id = ${articleLiteral};
    COMMIT;
  `
}

const getQueuedTasks = async () => {
  return getAppDatabaseService().queryJson<MartRefreshTaskRow>(`
    SELECT
      id,
      refresh_scope AS refreshScope,
      project_id AS projectId,
      article_id AS articleId
    FROM app.mart_refresh_queue
    ORDER BY created_at ASC, id ASC
    LIMIT ${martRefreshBatchLimit}
  `)
}

const getHasQueuedTasks = async () => {
  const rows = await getAppDatabaseService().queryJson<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.mart_refresh_queue
  `)

  return Number(rows[0]?.count ?? 0) > 0
}

const deleteQueuedTasks = async (taskIds: string[]) => {
  if (taskIds.length === 0) {
    return
  }

  await getAppDatabaseService().run(`
    DELETE FROM app.mart_refresh_queue
    WHERE id IN (${getQuotedStringList(taskIds).join(', ')})
  `)
}

const getUniqueValues = (values: Array<string | null | undefined>) => {
  return Array.from(
    new Set(
      values.filter((value): value is string => {
        return typeof value === 'string' && value !== ''
      }),
    ),
  )
}

const getImpactedProjectIdsForArticle = async (articleId: string) => {
  const rows = await getAppDatabaseService().queryJson<{projectId: string}>(`
    SELECT project_id AS projectId
    FROM app.project_article
    WHERE article_id = ${getSqlLiteral(articleId)}
    UNION
    SELECT pir.project_id AS projectId
    FROM app.project_import_route pir
    INNER JOIN app.article_import_route air ON air.import_route_id = pir.import_route_id
    WHERE air.article_id = ${getSqlLiteral(articleId)}
  `)

  return rows.map((row) => {
    return row.projectId
  })
}

const refreshProject = async (projectId: string) => {
  const statements = getProjectRefreshSql(projectId)
  const [currentStatement = ''] = statements

  if (!currentStatement) {
    return
  }

  await getAppDatabaseService().run(currentStatement)
  return refreshProjectStatements(projectId, statements.slice(1))
}

const refreshProjectStatements = async (projectId: string, statements: string[]): Promise<void> => {
  const [currentStatement = ''] = statements

  if (!currentStatement) {
    return
  }

  await getAppDatabaseService().run(currentStatement)
  return refreshProjectStatements(projectId, statements.slice(1))
}

const refreshJudgmentArticle = async (articleId: string) => {
  await getAppDatabaseService().run(getJudgmentArticleRefreshSql(articleId))
}

const processQueuedMartRefreshes = async (): Promise<void> => {
  const queuedTasks = await getQueuedTasks()

  if (queuedTasks.length === 0) {
    return
  }

  const taskIds = queuedTasks.map((task) => {
    return task.id
  })
  const articleIds = getUniqueValues(
    queuedTasks
      .filter((task) => {
        return task.refreshScope === 'judgment_article'
      })
      .map((task) => {
        return task.articleId
      }),
  )
  const projectIds = new Set(
    getUniqueValues(
      queuedTasks
        .filter((task) => {
          return task.refreshScope === 'project'
        })
        .map((task) => {
          return task.projectId
        }),
    ),
  )

  for (const articleId of articleIds) {
    await refreshJudgmentArticle(articleId)
    for (const projectId of await getImpactedProjectIdsForArticle(articleId)) {
      projectIds.add(projectId)
    }
  }

  for (const projectId of projectIds) {
    await refreshProject(projectId)
  }

  await deleteQueuedTasks(taskIds)

  return processQueuedMartRefreshes()
}

const scheduleQueuedMartRefreshes = (delayMs = martRefreshScheduleDelayMs) => {
  if (martRefreshDrainTimer || martRefreshDrainPromise) {
    return
  }

  martRefreshDrainTimer = setTimeout(() => {
    martRefreshDrainTimer = null
    void flushQueuedMartRefreshes().catch((error) => {
      console.error('[duckdbMartRefresh] failed to process refresh queue', error)
      scheduleQueuedMartRefreshes(martRefreshRetryDelayMs)
    })
  }, delayMs)
}

const queueMartRefreshTasks = async (tasks: QueueMartRefreshTask[]) => {
  if (tasks.length === 0) {
    return
  }

  await getAppDatabaseService().run(`
    INSERT INTO app.mart_refresh_queue (
      id,
      refresh_scope,
      project_id,
      article_id,
      project_key,
      article_key,
      reason,
      created_at,
      updated_at
    )
    VALUES ${tasks
      .map((task) => {
        const projectId = task.projectId ?? null
        const articleId = task.articleId ?? null
        return `(${getQuotedStringList([randomUUID(), task.refreshScope]).join(', ')}, ${getSqlLiteral(projectId)}, ${getSqlLiteral(articleId)}, ${getSqlLiteral(projectId ?? '')}, ${getSqlLiteral(articleId ?? '')}, ${getSqlLiteral(task.reason)}, NOW(), NOW())`
      })
      .join(', ')}
    ON CONFLICT(refresh_scope, project_key, article_key) DO UPDATE SET
      reason = excluded.reason,
      updated_at = NOW()
  `)

  scheduleQueuedMartRefreshes()
}

export const flushQueuedMartRefreshes = async (): Promise<void> => {
  if (martRefreshDrainPromise) {
    return martRefreshDrainPromise
  }

  if (martRefreshDrainTimer) {
    clearTimeout(martRefreshDrainTimer)
    martRefreshDrainTimer = null
  }

  martRefreshDrainPromise = processQueuedMartRefreshes().finally(async () => {
    martRefreshDrainPromise = null

    if (await getHasQueuedTasks()) {
      scheduleQueuedMartRefreshes()
    }
  })

  return martRefreshDrainPromise
}

const queueProjectRefreshes = async (projectIds: string[], reason: string) => {
  return queueMartRefreshTasks(
    getUniqueValues(projectIds).map((projectId) => {
      return {projectId, reason, refreshScope: 'project' as const}
    }),
  )
}

const queueJudgmentArticleRefreshes = async (articleIds: string[], reason: string) => {
  return queueMartRefreshTasks(
    getUniqueValues(articleIds).map((articleId) => {
      return {articleId, reason, refreshScope: 'judgment_article' as const}
    }),
  )
}

const queueProjectRefreshesByImportRouteIds = async (importRouteIds: string[], reason: string) => {
  if (importRouteIds.length === 0) {
    return
  }

  const rows = await getAppDatabaseService().queryJson<{projectId: string}>(`
    SELECT DISTINCT project_id AS projectId
    FROM app.project_import_route
    WHERE import_route_id IN (${getQuotedStringList(getUniqueValues(importRouteIds)).join(', ')})
  `)

  return queueProjectRefreshes(
    rows.map((row) => {
      return row.projectId
    }),
    reason,
  )
}

const queueProjectRefreshesByPromptIds = async (promptIds: string[], reason: string) => {
  if (promptIds.length === 0) {
    return
  }

  const rows = await getAppDatabaseService().queryJson<{projectId: string}>(`
    SELECT DISTINCT project_id AS projectId
    FROM app.project_prompt
    WHERE prompt_id IN (${getQuotedStringList(getUniqueValues(promptIds)).join(', ')})
  `)

  return queueProjectRefreshes(
    rows.map((row) => {
      return row.projectId
    }),
    reason,
  )
}

const queueJudgmentArticleRefreshesByJudgmentIds = async (judgmentIds: string[], reason: string) => {
  if (judgmentIds.length === 0) {
    return
  }

  const rows = await getAppDatabaseService().queryJson<{articleId: string}>(`
    SELECT DISTINCT article_id AS articleId
    FROM app.judgment
    WHERE id IN (${getQuotedStringList(getUniqueValues(judgmentIds)).join(', ')})
  `)

  return queueJudgmentArticleRefreshes(
    rows.map((row) => {
      return row.articleId
    }),
    reason,
  )
}

const queueJudgmentArticleRefreshesByPromptIds = async (promptIds: string[], reason: string) => {
  if (promptIds.length === 0) {
    return
  }

  const rows = await getAppDatabaseService().queryJson<{articleId: string}>(`
    SELECT DISTINCT article_id AS articleId
    FROM app.judgment
    WHERE prompt_id IN (${getQuotedStringList(getUniqueValues(promptIds)).join(', ')})
  `)

  return queueJudgmentArticleRefreshes(
    rows.map((row) => {
      return row.articleId
    }),
    reason,
  )
}

const duckdbMartRefreshService = {
  flush: flushQueuedMartRefreshes,
  queueJudgmentArticleRefresh: async (articleId: string, reason: string) => {
    await queueJudgmentArticleRefreshes([articleId], reason)
  },
  queueJudgmentArticleRefreshes,
  queueJudgmentArticleRefreshesByJudgmentIds,
  queueJudgmentArticleRefreshesByPromptIds,
  queueProjectRefresh: async (projectId: string, reason: string) => {
    await queueProjectRefreshes([projectId], reason)
  },
  queueProjectRefreshes,
  queueProjectRefreshesByImportRouteIds,
  queueProjectRefreshesByPromptIds,
}

export const getDuckdbMartRefreshService = () => {
  return duckdbMartRefreshService
}
