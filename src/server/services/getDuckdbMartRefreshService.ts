import {randomUUID} from 'node:crypto'

import {getAppDatabaseService} from './appDatabaseService.ts'
import {getQuotedStringList, getSqlLiteral} from './appQueryHelpers.ts'

type MartRefreshScope = 'judgment_article' | 'project'

type MartRefreshTaskRow = {
  articleId: string | null
  id: string
  projectId: string | null
  refreshGeneration: number
  refreshScope: MartRefreshScope
}

type QueueMartRefreshTask = {
  articleId?: string | null
  projectId?: string | null
  reason: string
  refreshScope: MartRefreshScope
}

type MartRefreshProgressSnapshot = {
  claimedQueuedArticleIds: string[]
  claimedQueuedProjectIds: string[]
  processingArticleIds: string[]
  processingProjectIds: string[]
}

type MartRefreshDebugSnapshot = {
  autoDrainEnabled: boolean
  drainPromiseActive: boolean
  drainTimerActive: boolean
  flushInvocationCount: number
  lastErrorAt: string | null
  lastErrorMessage: string | null
  lastFlushAt: string | null
  lastHasMoreQueuedTasks: boolean | null
  lastPassCompletedAt: string | null
  lastPassStartedAt: string | null
  lastQueuedTaskCount: number | null
  passCount: number
}

const getEmptyMartRefreshProgressSnapshot = (): MartRefreshProgressSnapshot => {
  return {claimedQueuedArticleIds: [], claimedQueuedProjectIds: [], processingArticleIds: [], processingProjectIds: []}
}

const copyMartRefreshProgressSnapshot = (snapshot: MartRefreshProgressSnapshot): MartRefreshProgressSnapshot => {
  return {
    claimedQueuedArticleIds: [...snapshot.claimedQueuedArticleIds],
    claimedQueuedProjectIds: [...snapshot.claimedQueuedProjectIds],
    processingArticleIds: [...snapshot.processingArticleIds],
    processingProjectIds: [...snapshot.processingProjectIds],
  }
}

const getEmptyMartRefreshDebugSnapshot = (): MartRefreshDebugSnapshot => {
  return {
    autoDrainEnabled: true,
    drainPromiseActive: false,
    drainTimerActive: false,
    flushInvocationCount: 0,
    lastErrorAt: null,
    lastErrorMessage: null,
    lastFlushAt: null,
    lastHasMoreQueuedTasks: null,
    lastPassCompletedAt: null,
    lastPassStartedAt: null,
    lastQueuedTaskCount: null,
    passCount: 0,
  }
}

let martRefreshDrainPromise: Promise<void> | null = null
let martRefreshDrainTimer: ReturnType<typeof setTimeout> | null = null
let martRefreshQueueCompletedAtColumnReady: Promise<void> | null = null
let martRefreshQueueCompletedAtColumnVerified = false
let martRefreshQueueGenerationColumnReady: Promise<void> | null = null
let martRefreshQueueGenerationColumnVerified = false
let martRefreshKnownNoopQueueRowsReady: Promise<void> | null = null
let martRefreshKnownNoopQueueRowsVerified = false
let martRefreshReviewArticleRollupReady: Promise<void> | null = null
let martRefreshReviewArticleRollupVerified = false
let martRefreshAutoDrainEnabled = true
let martRefreshDebugSnapshot = getEmptyMartRefreshDebugSnapshot()
let martRefreshProgressSnapshot = getEmptyMartRefreshProgressSnapshot()
let martRefreshArticleCompletionTimes: number[] = []
let martRefreshProjectCompletionTimes: number[] = []

const martRefreshArticleBatchLimit = 4
const martRefreshDrainBudgetMs = 100
const martRefreshProjectBatchLimit = 1
const martRefreshRetryDelayMs = 5000
const martRefreshScheduleDelayMs = 250
const martRefreshThroughputWindowMs = 15_000
const martRefreshYieldDelayMs = 0
const knownNoopProjectRefreshReasons = ['humanAssessmentRoutesPostInit']

const getMartRefreshProgressSnapshot = (): MartRefreshProgressSnapshot => {
  return copyMartRefreshProgressSnapshot(martRefreshProgressSnapshot)
}

const setMartRefreshProgressSnapshot = (snapshot: MartRefreshProgressSnapshot) => {
  martRefreshProgressSnapshot = copyMartRefreshProgressSnapshot(snapshot)
}

const resetMartRefreshProgressSnapshot = () => {
  setMartRefreshProgressSnapshot(getEmptyMartRefreshProgressSnapshot())
}

const getRecentCompletionTimes = (completionTimes: number[], now: number) => {
  return completionTimes.filter((completedAt) => {
    return completedAt >= now - martRefreshThroughputWindowMs
  })
}

const getRefreshesPerMinute = (completionTimes: number[], now: number) => {
  const recentCompletionTimes = getRecentCompletionTimes(completionTimes, now)

  return recentCompletionTimes.length === 0
    ? null
    : (recentCompletionTimes.length / martRefreshThroughputWindowMs) * 60_000
}

const getMartRefreshThroughputSnapshot = () => {
  const now = Date.now()

  return {
    articleRefreshesPerMinute: getRefreshesPerMinute(martRefreshArticleCompletionTimes, now),
    projectRefreshesPerMinute: getRefreshesPerMinute(martRefreshProjectCompletionTimes, now),
  }
}

const recordArticleRefreshCompletion = (completedAt = Date.now()) => {
  martRefreshArticleCompletionTimes = [
    ...getRecentCompletionTimes(martRefreshArticleCompletionTimes, completedAt),
    completedAt,
  ]
}

const recordProjectRefreshCompletion = (completedAt = Date.now()) => {
  martRefreshProjectCompletionTimes = [
    ...getRecentCompletionTimes(martRefreshProjectCompletionTimes, completedAt),
    completedAt,
  ]
}

const resetMartRefreshThroughputSnapshot = () => {
  martRefreshArticleCompletionTimes = []
  martRefreshProjectCompletionTimes = []
}

const getMartRefreshDebugSnapshot = () => {
  return {
    ...martRefreshDebugSnapshot,
    autoDrainEnabled: martRefreshAutoDrainEnabled,
    drainPromiseActive: martRefreshDrainPromise !== null,
    drainTimerActive: martRefreshDrainTimer !== null,
  }
}

const updateMartRefreshDebugSnapshot = (updates: Partial<MartRefreshDebugSnapshot>) => {
  martRefreshDebugSnapshot = {...martRefreshDebugSnapshot, ...updates}
}

const resetMartRefreshDebugSnapshot = () => {
  martRefreshDebugSnapshot = getEmptyMartRefreshDebugSnapshot()
}

const isMartRefreshAutoDrainEnabled = () => {
  return martRefreshAutoDrainEnabled
}

const setMartRefreshAutoDrainEnabled = (enabled: boolean) => {
  martRefreshAutoDrainEnabled = enabled
  updateMartRefreshDebugSnapshot({autoDrainEnabled: enabled})
}

const setClaimedQueuedRefreshes = (articleIds: string[], projectIds: string[]) => {
  setMartRefreshProgressSnapshot({
    claimedQueuedArticleIds: articleIds,
    claimedQueuedProjectIds: projectIds,
    processingArticleIds: articleIds,
    processingProjectIds: projectIds,
  })
}

const setProcessingArticleRefreshes = (articleIds: string[]) => {
  setMartRefreshProgressSnapshot({...martRefreshProgressSnapshot, processingArticleIds: articleIds})
}

const setProcessingProjectRefreshes = (projectIds: string[]) => {
  setMartRefreshProgressSnapshot({...martRefreshProgressSnapshot, processingProjectIds: projectIds})
}

const getHasMartRefreshQueueGenerationColumn = async (): Promise<boolean> => {
  const rows = await getAppDatabaseService().queryJson<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM information_schema.columns
    WHERE table_schema = 'app'
      AND table_name = 'mart_refresh_queue'
      AND column_name = 'refresh_generation'
  `)

  return Number(rows[0]?.count ?? 0) > 0
}

const getHasMartRefreshQueueCompletedAtColumn = async (): Promise<boolean> => {
  const rows = await getAppDatabaseService().queryJson<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM information_schema.columns
    WHERE table_schema = 'app'
      AND table_name = 'mart_refresh_queue'
      AND column_name = 'completed_at'
  `)

  return Number(rows[0]?.count ?? 0) > 0
}

const getHasNullMartRefreshQueueGenerationRows = async (): Promise<boolean> => {
  const rows = await getAppDatabaseService().queryJson<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.mart_refresh_queue
    WHERE refresh_generation IS NULL
  `)

  return Number(rows[0]?.count ?? 0) > 0
}

const repairMartRefreshQueueGenerationColumn = async () => {
  await getAppDatabaseService().run(`
    ALTER TABLE app.mart_refresh_queue ADD COLUMN IF NOT EXISTS refresh_generation BIGINT;
    UPDATE app.mart_refresh_queue
    SET refresh_generation = 0
    WHERE refresh_generation IS NULL;
  `)

  await getAppDatabaseService().maintenance('checkpoint')
}

const repairMartRefreshQueueCompletedAtColumn = async () => {
  await getAppDatabaseService().run(`
    ALTER TABLE app.mart_refresh_queue ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
  `)

  await getAppDatabaseService().maintenance('checkpoint')
}

const verifyMartRefreshQueueGenerationColumn = async () => {
  const hasGenerationColumn = await getHasMartRefreshQueueGenerationColumn()

  if (!hasGenerationColumn) {
    return repairMartRefreshQueueGenerationColumn()
  }

  return (await getHasNullMartRefreshQueueGenerationRows()) ? repairMartRefreshQueueGenerationColumn() : undefined
}

const verifyMartRefreshQueueCompletedAtColumn = async () => {
  return (await getHasMartRefreshQueueCompletedAtColumn()) ? undefined : repairMartRefreshQueueCompletedAtColumn()
}

const getQueuedArticleTasksSql = () => {
  return `
    SELECT
      id,
      refresh_scope AS refreshScope,
      project_id AS projectId,
      article_id AS articleId,
      COALESCE(refresh_generation, 0) AS refreshGeneration
    FROM app.mart_refresh_queue
    WHERE completed_at IS NULL
      AND refresh_scope = 'judgment_article'
    ORDER BY EPOCH(created_at) ASC, id ASC
    LIMIT ${martRefreshArticleBatchLimit}
  `
}

const getQueuedProjectTasksSql = () => {
  return `
    WITH queued_project_task AS (
      SELECT
        id,
        refresh_scope AS refreshScope,
        project_id AS projectId,
        article_id AS articleId,
        created_at AS createdAt,
        COALESCE(refresh_generation, 0) AS refreshGeneration
      FROM app.mart_refresh_queue
      WHERE completed_at IS NULL
        AND refresh_scope = 'project'
    ),
    project_scope_size AS (
      SELECT
        project_scope_article.project_id AS projectId,
        COUNT(*) AS scopeCount
      FROM mart.project_scope_article project_scope_article
      INNER JOIN queued_project_task ON queued_project_task.projectId = project_scope_article.project_id
      GROUP BY project_scope_article.project_id
    )
    SELECT
      queued_project_task.id,
      queued_project_task.refreshScope,
      queued_project_task.projectId,
      queued_project_task.articleId,
      queued_project_task.refreshGeneration
    FROM queued_project_task
    LEFT JOIN project_scope_size ON project_scope_size.projectId = queued_project_task.projectId
    ORDER BY COALESCE(project_scope_size.scopeCount, 0) ASC, EPOCH(queued_project_task.createdAt) ASC, queued_project_task.id ASC
    LIMIT ${martRefreshProjectBatchLimit}
  `
}

const ensureMartRefreshQueueGenerationColumn = async (): Promise<void> => {
  if (martRefreshQueueGenerationColumnVerified) {
    return
  }

  if (martRefreshQueueGenerationColumnReady) {
    return martRefreshQueueGenerationColumnReady
  }

  martRefreshQueueGenerationColumnReady = verifyMartRefreshQueueGenerationColumn()
    .then(() => {
      martRefreshQueueGenerationColumnVerified = true
    })
    .catch((error) => {
      martRefreshQueueGenerationColumnReady = null
      return Promise.reject(error)
    })

  return martRefreshQueueGenerationColumnReady
}

const ensureMartRefreshQueueCompletedAtColumn = async (): Promise<void> => {
  if (martRefreshQueueCompletedAtColumnVerified) {
    return
  }

  if (martRefreshQueueCompletedAtColumnReady) {
    return martRefreshQueueCompletedAtColumnReady
  }

  martRefreshQueueCompletedAtColumnReady = verifyMartRefreshQueueCompletedAtColumn()
    .then(() => {
      martRefreshQueueCompletedAtColumnVerified = true
    })
    .catch((error) => {
      martRefreshQueueCompletedAtColumnReady = null
      return Promise.reject(error)
    })

  return martRefreshQueueCompletedAtColumnReady
}

const ensureMartRefreshQueueSchema = async (): Promise<void> => {
  await ensureMartRefreshQueueGenerationColumn()
  return ensureMartRefreshQueueCompletedAtColumn()
}

const pruneKnownNoopQueuedProjectRefreshes = async (): Promise<void> => {
  if (knownNoopProjectRefreshReasons.length === 0) {
    return
  }

  await ensureMartRefreshQueueSchema()

  return getAppDatabaseService().run(`
    UPDATE app.mart_refresh_queue
    SET completed_at = NOW(),
        updated_at = NOW()
    WHERE completed_at IS NULL
      AND refresh_scope = 'project'
      AND reason IN (${getQuotedStringList(knownNoopProjectRefreshReasons).join(', ')})
  `)
}

const ensureKnownNoopQueuedProjectRefreshesPruned = async (): Promise<void> => {
  if (martRefreshKnownNoopQueueRowsVerified) {
    return
  }

  if (martRefreshKnownNoopQueueRowsReady) {
    return martRefreshKnownNoopQueueRowsReady
  }

  martRefreshKnownNoopQueueRowsReady = pruneKnownNoopQueuedProjectRefreshes()
    .then(() => {
      martRefreshKnownNoopQueueRowsVerified = true
    })
    .catch((error) => {
      martRefreshKnownNoopQueueRowsReady = null
      return Promise.reject(error)
    })

  return martRefreshKnownNoopQueueRowsReady
}

const createReviewArticleRollupTable = async () => {
  await getAppDatabaseService().run(`
    CREATE TABLE IF NOT EXISTS mart.review_article_rollup (
      project_id VARCHAR NOT NULL,
      article_id VARCHAR NOT NULL,
      article_created_at TIMESTAMPTZ,
      article_updated_at TIMESTAMPTZ,
      enabled_prompt_count INTEGER NOT NULL,
      llm_judged_prompt_count INTEGER NOT NULL,
      human_answered_prompt_count INTEGER NOT NULL,
      llm_judged_prompt_ids VARCHAR[],
      human_answered_prompt_ids VARCHAR[],
      has_all_llm_judgments BOOLEAN NOT NULL,
      has_all_human_answers BOOLEAN NOT NULL,
      in_curated_scope BOOLEAN NOT NULL,
      in_route_scope BOOLEAN NOT NULL,
      review_opened BOOLEAN NOT NULL,
      review_sections_completed INTEGER NOT NULL,
      latest_llm_created_at TIMESTAMPTZ,
      latest_human_updated_at TIMESTAMPTZ,
      latest_review_updated_at TIMESTAMPTZ,
      rollup_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
      PRIMARY KEY(project_id, article_id)
    )
  `)
  await getAppDatabaseService().run(`
    CREATE INDEX IF NOT EXISTS idx_mart_review_article_rollup_project_id
    ON mart.review_article_rollup(project_id, has_all_llm_judgments, article_created_at, article_id)
  `)
}

const ensureReviewArticleRollupTable = async (): Promise<void> => {
  if (martRefreshReviewArticleRollupVerified) {
    return
  }

  if (martRefreshReviewArticleRollupReady) {
    return martRefreshReviewArticleRollupReady
  }

  martRefreshReviewArticleRollupReady = createReviewArticleRollupTable()
    .then(() => {
      martRefreshReviewArticleRollupVerified = true
    })
    .catch((error) => {
      martRefreshReviewArticleRollupReady = null
      return Promise.reject(error)
    })

  return martRefreshReviewArticleRollupReady
}

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
        article_created_at,
        article_updated_at
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
          COALESCE(BOOL_OR(in_route_scope), FALSE) AS in_route_scope
        FROM combined_scope
        GROUP BY project_id, article_id
      )
      SELECT
        aggregated_scope.project_id,
        aggregated_scope.article_id,
        aggregated_scope.in_curated_scope,
        aggregated_scope.in_route_scope,
        article.article_created_at,
        article.article_updated_at
      FROM aggregated_scope
      INNER JOIN app.project project
        ON project.id = aggregated_scope.project_id
       AND project.archived = FALSE
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
    `,
    `
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
    `,
    `
      BEGIN TRANSACTION;
      DELETE FROM mart.review_article_rollup WHERE project_id = ${projectLiteral};
      INSERT INTO mart.review_article_rollup (
        project_id,
        article_id,
        article_created_at,
        article_updated_at,
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
        scope_article.article_created_at,
        scope_article.article_updated_at,
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
    `
      BEGIN TRANSACTION;
      INSERT INTO app.project_review_serving_generation (
        project_id,
        active_generation,
        generation_updated_at
      )
      VALUES (
        ${projectLiteral},
        0,
        current_timestamp
      )
      ON CONFLICT(project_id) DO NOTHING;
      DELETE FROM mart.review_article_serving
      WHERE project_id = ${projectLiteral}
        AND generation = (
          SELECT active_generation + 1
          FROM app.project_review_serving_generation
          WHERE project_id = ${projectLiteral}
        );
      DELETE FROM mart.review_article_filter_member
      WHERE project_id = ${projectLiteral}
        AND generation = (
          SELECT active_generation + 1
          FROM app.project_review_serving_generation
          WHERE project_id = ${projectLiteral}
        );
      DELETE FROM mart.review_article_serving_detail
      WHERE project_id = ${projectLiteral}
        AND generation = (
          SELECT active_generation + 1
          FROM app.project_review_serving_generation
          WHERE project_id = ${projectLiteral}
        );
      INSERT INTO mart.review_article_serving (
        project_id,
        generation,
        article_id,
        article_created_at,
        article_updated_at,
        article_title,
        article_external_id,
        journal_title,
        url,
        full_text_pdf,
        full_text_fetched_at,
        full_text_conversion_status,
        source_metadata,
        has_all_llm_judgments,
        llm_judged_prompt_count,
        llm_judged_prompt_ids,
        enabled_prompt_count,
        human_answered_prompt_count,
        human_answered_prompt_ids,
        has_all_human_answers,
        review_opened,
        review_sections_completed,
        latest_llm_created_at,
        latest_human_updated_at,
        latest_review_updated_at,
        serving_updated_at
      )
      SELECT
        rollup.project_id,
        (
          SELECT active_generation + 1
          FROM app.project_review_serving_generation
          WHERE project_id = ${projectLiteral}
        ) AS generation,
        rollup.article_id,
        rollup.article_created_at,
        rollup.article_updated_at,
        article.article_title,
        article.article_id,
        json_extract_string(article.source_metadata, '$.journalTitle'),
        article.url,
        article.full_text_pdf,
        article.full_text_fetched_at,
        article.full_text_conversion_status,
        article.source_metadata,
        rollup.has_all_llm_judgments,
        rollup.llm_judged_prompt_count,
        rollup.llm_judged_prompt_ids,
        rollup.enabled_prompt_count,
        rollup.human_answered_prompt_count,
        rollup.human_answered_prompt_ids,
        rollup.has_all_human_answers,
        rollup.review_opened,
        rollup.review_sections_completed,
        rollup.latest_llm_created_at,
        rollup.latest_human_updated_at,
        rollup.latest_review_updated_at,
        current_timestamp
      FROM mart.review_article_rollup rollup
      INNER JOIN app.article article ON article.id = rollup.article_id
      WHERE rollup.project_id = ${projectLiteral};
      INSERT INTO mart.review_article_filter_member (
        project_id,
        generation,
        prompt_id,
        answer_id,
        article_id,
        article_created_at,
        numeric_answer_value,
        member_updated_at
      )
      SELECT DISTINCT
        fact.project_id,
        (
          SELECT active_generation + 1
          FROM app.project_review_serving_generation
          WHERE project_id = ${projectLiteral}
        ) AS generation,
        fact.prompt_id,
        dict.answer_id,
        fact.article_id,
        rollup.article_created_at,
        dict.numeric_answer_value,
        current_timestamp
      FROM mart.prompt_answer_fact fact
      INNER JOIN app.review_answer_dictionary dict
        ON dict.project_id = fact.project_id
       AND dict.prompt_id = fact.prompt_id
       AND dict.answer_value = fact.answer_value
      INNER JOIN mart.review_article_rollup rollup
        ON rollup.project_id = fact.project_id
       AND rollup.article_id = fact.article_id
      WHERE fact.project_id = ${projectLiteral};
      INSERT INTO mart.review_article_serving_detail (
        project_id,
        generation,
        article_id,
        prompt_id,
        prompt_order,
        judgment_id,
        created_at,
        article_created_at,
        article_updated_at,
        model_id,
        answered_original,
        answered_original_as_array,
        detail_updated_at
      )
      SELECT
        scope_article.project_id,
        (
          SELECT active_generation + 1
          FROM app.project_review_serving_generation
          WHERE project_id = ${projectLiteral}
        ) AS generation,
        judgment_fact.article_id,
        judgment_fact.prompt_id,
        project_prompt.prompt_order,
        judgment_fact.judgment_id,
        judgment_fact.created_at,
        judgment_fact.article_created_at,
        judgment_fact.article_updated_at,
        judgment_fact.model_id,
        judgment_fact.answered_original,
        judgment_fact.answered_original_as_array,
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
      UPDATE app.project_review_serving_generation
      SET active_generation = active_generation + 1,
          generation_updated_at = current_timestamp
      WHERE project_id = ${projectLiteral};
      DELETE FROM mart.review_article_filter_member
      WHERE project_id = ${projectLiteral}
        AND generation < (
          SELECT active_generation - 1
          FROM app.project_review_serving_generation
          WHERE project_id = ${projectLiteral}
        );
      DELETE FROM mart.review_article_serving
      WHERE project_id = ${projectLiteral}
        AND generation < (
          SELECT active_generation - 1
          FROM app.project_review_serving_generation
          WHERE project_id = ${projectLiteral}
        );
      DELETE FROM mart.review_article_serving_detail
      WHERE project_id = ${projectLiteral}
        AND generation < (
          SELECT active_generation - 1
          FROM app.project_review_serving_generation
          WHERE project_id = ${projectLiteral}
        );
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

const getQueuedArticleTasks = async () => {
  await ensureMartRefreshQueueSchema()
  return getAppDatabaseService().queryJson<MartRefreshTaskRow>(getQueuedArticleTasksSql())
}

const getQueuedProjectTasks = async () => {
  await ensureMartRefreshQueueSchema()
  return getAppDatabaseService().queryJson<MartRefreshTaskRow>(getQueuedProjectTasksSql())
}

const getHasQueuedTasks = async () => {
  await ensureMartRefreshQueueSchema()
  const rows = await getAppDatabaseService().queryJson<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.mart_refresh_queue
    WHERE completed_at IS NULL
  `)

  return Number(rows[0]?.count ?? 0) > 0
}

const completeQueuedTask = async (task: MartRefreshTaskRow) => {
  await getAppDatabaseService().run(`
    UPDATE app.mart_refresh_queue
    SET completed_at = NOW(),
        updated_at = NOW()
    WHERE id = ${getSqlLiteral(task.id)}
      AND COALESCE(refresh_generation, 0) = ${task.refreshGeneration}
  `)
}

const completeQueuedTasks = async (tasks: MartRefreshTaskRow[]): Promise<void> => {
  const [currentTask] = tasks

  if (!currentTask) {
    return
  }

  await completeQueuedTask(currentTask)
  return completeQueuedTasks(tasks.slice(1))
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

const queryMartRefreshBackgroundJson = async <T>(statement: string): Promise<T[]> => {
  return getAppDatabaseService().queryJsonBackground<T>(statement)
}

const getNormalizedMartRefreshError = (error: unknown): Error => {
  return error instanceof Error ? error : new Error(String(error))
}

const getChainedMartRefreshError = (error: unknown, nextError: unknown, context: string): Error => {
  const normalizedError = getNormalizedMartRefreshError(error)
  const normalizedNextError = getNormalizedMartRefreshError(nextError)
  const combinedMessage =
    normalizedNextError.message === normalizedError.message
      ? normalizedError.message
      : `${normalizedError.message} -- ${context}: ${normalizedNextError.message}`

  return combinedMessage === normalizedError.message ? normalizedError : new Error(combinedMessage)
}

const hasMartRefreshExplicitTransaction = (statement: string) => {
  const normalizedStatement = statement.toUpperCase()

  return normalizedStatement.includes('BEGIN TRANSACTION') || normalizedStatement.includes('START TRANSACTION')
}

const shouldAttemptMartRefreshBackgroundRollback = (statement: string, error: unknown) => {
  const normalizedError = getNormalizedMartRefreshError(error)

  return (
    hasMartRefreshExplicitTransaction(statement)
    || normalizedError.message.includes('Current transaction is aborted')
    || normalizedError.message.includes('please ROLLBACK')
  )
}

const getMartRefreshBackgroundRollbackError = async (): Promise<Error | null> => {
  try {
    await getAppDatabaseService().runBackground('ROLLBACK')
    return null
  } catch (error) {
    return getNormalizedMartRefreshError(error)
  }
}

const runMartRefreshBackgroundStatement = async (statement: string) => {
  try {
    await getAppDatabaseService().runBackground(statement)
  } catch (error) {
    const rollbackError = shouldAttemptMartRefreshBackgroundRollback(statement, error)
      ? await getMartRefreshBackgroundRollbackError()
      : null

    throw rollbackError === null ? error : getChainedMartRefreshError(error, rollbackError, 'rollback failed')
  }
}

const getImpactedProjectIdsForArticle = async (articleId: string) => {
  const rows = await queryMartRefreshBackgroundJson<{projectId: string}>(`
    SELECT project_article.project_id AS projectId
    FROM app.project_article project_article
    INNER JOIN app.project project ON project.id = project_article.project_id
    WHERE project_article.article_id = ${getSqlLiteral(articleId)}
      AND project.archived = FALSE
    UNION
    SELECT pir.project_id AS projectId
    FROM app.project_import_route pir
    INNER JOIN app.project project ON project.id = pir.project_id
    INNER JOIN app.article_import_route air ON air.import_route_id = pir.import_route_id
    WHERE air.article_id = ${getSqlLiteral(articleId)}
      AND project.archived = FALSE
  `)

  return rows.map((row) => {
    return row.projectId
  })
}

const getHasActiveProjectReviewServingGeneration = async (projectId: string) => {
  const rows = await queryMartRefreshBackgroundJson<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.project_review_serving_generation
    WHERE project_id = ${getSqlLiteral(projectId)}
      AND active_generation > 0
  `)

  return Number(rows[0]?.count ?? 0) > 0
}

const getProjectArticleServingRefreshSql = (projectId: string, articleId: string) => {
  const projectLiteral = getSqlLiteral(projectId)
  const articleLiteral = getSqlLiteral(articleId)

  return `
    BEGIN TRANSACTION;
    INSERT INTO app.review_answer_dictionary (
      project_id,
      prompt_id,
      answer_id,
      answer_value,
      numeric_answer_value,
      dictionary_updated_at
    )
    WITH article_scope AS (
      SELECT
        aggregated_scope.project_id,
        aggregated_scope.article_id,
        aggregated_scope.in_curated_scope,
        aggregated_scope.in_route_scope,
        article.article_created_at,
        article.article_updated_at
      FROM (
        SELECT
          combined_scope.project_id,
          combined_scope.article_id,
          COALESCE(BOOL_OR(combined_scope.in_curated_scope), FALSE) AS in_curated_scope,
          COALESCE(BOOL_OR(combined_scope.in_route_scope), FALSE) AS in_route_scope
        FROM (
          SELECT
            pir.project_id,
            air.article_id,
            FALSE AS in_curated_scope,
            TRUE AS in_route_scope
          FROM app.project_import_route pir
          INNER JOIN app.article_import_route air ON air.import_route_id = pir.import_route_id
          WHERE pir.project_id = ${projectLiteral}
            AND air.article_id = ${articleLiteral}
          UNION ALL
          SELECT
            pa.project_id,
            pa.article_id,
            TRUE AS in_curated_scope,
            FALSE AS in_route_scope
          FROM app.project_article pa
          WHERE pa.project_id = ${projectLiteral}
            AND pa.article_id = ${articleLiteral}
        ) combined_scope
        GROUP BY combined_scope.project_id, combined_scope.article_id
      ) aggregated_scope
      INNER JOIN app.project project
        ON project.id = aggregated_scope.project_id
       AND project.archived = FALSE
      INNER JOIN app.article article ON article.id = aggregated_scope.article_id
    ),
    enabled_project_prompt AS (
      SELECT project_id, prompt_id
      FROM app.project_prompt
      WHERE enabled = TRUE
        AND project_id = ${projectLiteral}
    ),
    eligible_project_judgment AS (
      SELECT
        article_scope.project_id,
        judgment_fact.prompt_id,
        judgment_fact.normalized_answers
      FROM article_scope
      INNER JOIN app.project project ON project.id = article_scope.project_id
      INNER JOIN enabled_project_prompt enabled_prompt
        ON enabled_prompt.project_id = article_scope.project_id
      INNER JOIN mart.judgment_fact judgment_fact
        ON judgment_fact.article_id = article_scope.article_id
       AND judgment_fact.prompt_id = enabled_prompt.prompt_id
       AND judgment_fact.model_id = project.model_id
       AND judgment_fact.use_title = project.use_title
       AND judgment_fact.use_abstract = project.use_abstract
       AND judgment_fact.use_fulltext = project.use_fulltext
       AND judgment_fact.use_fulltext_no_images = project.use_fulltext_no_images
    ),
    answer_values AS (
      SELECT DISTINCT
        eligible_project_judgment.project_id,
        eligible_project_judgment.prompt_id,
        TRIM(answer.answer_value) AS answer_value
      FROM eligible_project_judgment,
        UNNEST(eligible_project_judgment.normalized_answers) AS answer(answer_value)
      WHERE eligible_project_judgment.normalized_answers IS NOT NULL
        AND ARRAY_LENGTH(eligible_project_judgment.normalized_answers) > 0
        AND NULLIF(TRIM(answer.answer_value), '') IS NOT NULL
    ),
    missing_answer_values AS (
      SELECT answer_values.project_id, answer_values.prompt_id, answer_values.answer_value
      FROM answer_values
      LEFT JOIN app.review_answer_dictionary dictionary
        ON dictionary.project_id = answer_values.project_id
       AND dictionary.prompt_id = answer_values.prompt_id
       AND dictionary.answer_value = answer_values.answer_value
      WHERE dictionary.answer_id IS NULL
    ),
    current_answer_id AS (
      SELECT
        project_id,
        prompt_id,
        COALESCE(MAX(answer_id), 0) AS max_answer_id
      FROM app.review_answer_dictionary
      WHERE project_id = ${projectLiteral}
      GROUP BY project_id, prompt_id
    )
    SELECT
      missing_answer_values.project_id,
      missing_answer_values.prompt_id,
      COALESCE(current_answer_id.max_answer_id, 0)
        + ROW_NUMBER() OVER (
          PARTITION BY missing_answer_values.project_id, missing_answer_values.prompt_id
          ORDER BY missing_answer_values.answer_value ASC
        ) AS answer_id,
      missing_answer_values.answer_value,
      TRY_CAST(missing_answer_values.answer_value AS BIGINT),
      current_timestamp
    FROM missing_answer_values
    LEFT JOIN current_answer_id
      ON current_answer_id.project_id = missing_answer_values.project_id
     AND current_answer_id.prompt_id = missing_answer_values.prompt_id;

    DELETE FROM mart.review_article_filter_member
    WHERE project_id = ${projectLiteral}
      AND article_id = ${articleLiteral}
      AND generation = (
        SELECT active_generation
        FROM app.project_review_serving_generation
        WHERE project_id = ${projectLiteral}
      );

    DELETE FROM mart.review_article_serving
    WHERE project_id = ${projectLiteral}
      AND article_id = ${articleLiteral}
      AND generation = (
        SELECT active_generation
        FROM app.project_review_serving_generation
        WHERE project_id = ${projectLiteral}
      );

    INSERT INTO mart.review_article_serving (
      project_id,
      generation,
      article_id,
      article_created_at,
      article_updated_at,
      article_title,
      article_external_id,
      journal_title,
      url,
      full_text_pdf,
      full_text_fetched_at,
      full_text_conversion_status,
      source_metadata,
      has_all_llm_judgments,
      llm_judged_prompt_count,
      llm_judged_prompt_ids,
      enabled_prompt_count,
      human_answered_prompt_count,
      human_answered_prompt_ids,
      has_all_human_answers,
      review_opened,
      review_sections_completed,
      latest_llm_created_at,
      latest_human_updated_at,
      latest_review_updated_at,
      serving_updated_at
    )
    WITH article_scope AS (
      SELECT
        aggregated_scope.project_id,
        aggregated_scope.article_id,
        aggregated_scope.in_curated_scope,
        aggregated_scope.in_route_scope,
        article.article_created_at,
        article.article_updated_at
      FROM (
        SELECT
          combined_scope.project_id,
          combined_scope.article_id,
          COALESCE(BOOL_OR(combined_scope.in_curated_scope), FALSE) AS in_curated_scope,
          COALESCE(BOOL_OR(combined_scope.in_route_scope), FALSE) AS in_route_scope
        FROM (
          SELECT
            pir.project_id,
            air.article_id,
            FALSE AS in_curated_scope,
            TRUE AS in_route_scope
          FROM app.project_import_route pir
          INNER JOIN app.article_import_route air ON air.import_route_id = pir.import_route_id
          WHERE pir.project_id = ${projectLiteral}
            AND air.article_id = ${articleLiteral}
          UNION ALL
          SELECT
            pa.project_id,
            pa.article_id,
            TRUE AS in_curated_scope,
            FALSE AS in_route_scope
          FROM app.project_article pa
          WHERE pa.project_id = ${projectLiteral}
            AND pa.article_id = ${articleLiteral}
        ) combined_scope
        GROUP BY combined_scope.project_id, combined_scope.article_id
      ) aggregated_scope
      INNER JOIN app.project project
        ON project.id = aggregated_scope.project_id
       AND project.archived = FALSE
      INNER JOIN app.article article ON article.id = aggregated_scope.article_id
    ),
    enabled_project_prompt AS (
      SELECT project_id, prompt_id
      FROM app.project_prompt
      WHERE enabled = TRUE
        AND project_id = ${projectLiteral}
    ),
    enabled_project_prompt_count AS (
      SELECT project_id, COUNT(*) AS enabled_prompt_count
      FROM enabled_project_prompt
      GROUP BY project_id
    ),
    llm_project_prompt AS (
      SELECT
        article_scope.project_id,
        judgment_fact.article_id,
        judgment_fact.prompt_id,
        MAX(judgment_fact.created_at) AS latest_llm_created_at
      FROM article_scope
      INNER JOIN app.project project ON project.id = article_scope.project_id
      INNER JOIN enabled_project_prompt enabled_prompt
        ON enabled_prompt.project_id = article_scope.project_id
      INNER JOIN mart.judgment_fact judgment_fact
        ON judgment_fact.article_id = article_scope.article_id
       AND judgment_fact.prompt_id = enabled_prompt.prompt_id
       AND judgment_fact.model_id = project.model_id
       AND judgment_fact.use_title = project.use_title
       AND judgment_fact.use_abstract = project.use_abstract
       AND judgment_fact.use_fulltext = project.use_fulltext
       AND judgment_fact.use_fulltext_no_images = project.use_fulltext_no_images
      GROUP BY article_scope.project_id, judgment_fact.article_id, judgment_fact.prompt_id
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
        AND judgment_human.article_id = ${articleLiteral}
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
        AND review.article_id = ${articleLiteral}
      GROUP BY review.project_id, review.article_id
    )
    SELECT
      article_scope.project_id,
      (
        SELECT active_generation
        FROM app.project_review_serving_generation
        WHERE project_id = ${projectLiteral}
      ) AS generation,
      article_scope.article_id,
      article_scope.article_created_at,
      article_scope.article_updated_at,
      article.article_title,
      article.article_id,
      json_extract_string(article.source_metadata, '$.journalTitle'),
      article.url,
      article.full_text_pdf,
      article.full_text_fetched_at,
      article.full_text_conversion_status,
      article.source_metadata,
      COALESCE(prompt_count.enabled_prompt_count, 0) > 0
        AND COALESCE(llm_rollup.llm_judged_prompt_count, 0) = COALESCE(prompt_count.enabled_prompt_count, 0),
      COALESCE(llm_rollup.llm_judged_prompt_count, 0),
      llm_rollup.llm_judged_prompt_ids,
      COALESCE(prompt_count.enabled_prompt_count, 0),
      COALESCE(human_rollup.human_answered_prompt_count, 0),
      human_rollup.human_answered_prompt_ids,
      COALESCE(prompt_count.enabled_prompt_count, 0) > 0
        AND COALESCE(human_rollup.human_answered_prompt_count, 0) = COALESCE(prompt_count.enabled_prompt_count, 0),
      COALESCE(review_state.review_opened, FALSE),
      COALESCE(review_state.review_sections_completed, 0),
      llm_rollup.latest_llm_created_at,
      human_rollup.latest_human_updated_at,
      review_state.latest_review_updated_at,
      current_timestamp
    FROM article_scope
    INNER JOIN app.article article ON article.id = article_scope.article_id
    LEFT JOIN enabled_project_prompt_count prompt_count ON prompt_count.project_id = article_scope.project_id
    LEFT JOIN llm_project_rollup llm_rollup
      ON llm_rollup.project_id = article_scope.project_id
     AND llm_rollup.article_id = article_scope.article_id
    LEFT JOIN human_project_rollup human_rollup
      ON human_rollup.project_id = article_scope.project_id
     AND human_rollup.article_id = article_scope.article_id
    LEFT JOIN review_state
      ON review_state.project_id = article_scope.project_id
     AND review_state.article_id = article_scope.article_id;

    INSERT INTO mart.review_article_filter_member (
      project_id,
      generation,
      prompt_id,
      answer_id,
      article_id,
      article_created_at,
      numeric_answer_value,
      member_updated_at
    )
    WITH article_scope AS (
      SELECT aggregated_scope.project_id, aggregated_scope.article_id, article.article_created_at
      FROM (
        SELECT combined_scope.project_id, combined_scope.article_id
        FROM (
          SELECT pir.project_id, air.article_id
          FROM app.project_import_route pir
          INNER JOIN app.article_import_route air ON air.import_route_id = pir.import_route_id
          WHERE pir.project_id = ${projectLiteral}
            AND air.article_id = ${articleLiteral}
          UNION ALL
          SELECT pa.project_id, pa.article_id
          FROM app.project_article pa
          WHERE pa.project_id = ${projectLiteral}
            AND pa.article_id = ${articleLiteral}
        ) combined_scope
        GROUP BY combined_scope.project_id, combined_scope.article_id
      ) aggregated_scope
      INNER JOIN app.project project
        ON project.id = aggregated_scope.project_id
       AND project.archived = FALSE
      INNER JOIN app.article article ON article.id = aggregated_scope.article_id
    ),
    enabled_project_prompt AS (
      SELECT project_id, prompt_id
      FROM app.project_prompt
      WHERE enabled = TRUE
        AND project_id = ${projectLiteral}
    ),
    eligible_project_judgment AS (
      SELECT
        article_scope.project_id,
        article_scope.article_id,
        article_scope.article_created_at,
        judgment_fact.prompt_id,
        judgment_fact.normalized_answers
      FROM article_scope
      INNER JOIN app.project project ON project.id = article_scope.project_id
      INNER JOIN enabled_project_prompt enabled_prompt
        ON enabled_prompt.project_id = article_scope.project_id
      INNER JOIN mart.judgment_fact judgment_fact
        ON judgment_fact.article_id = article_scope.article_id
       AND judgment_fact.prompt_id = enabled_prompt.prompt_id
       AND judgment_fact.model_id = project.model_id
       AND judgment_fact.use_title = project.use_title
       AND judgment_fact.use_abstract = project.use_abstract
       AND judgment_fact.use_fulltext = project.use_fulltext
       AND judgment_fact.use_fulltext_no_images = project.use_fulltext_no_images
    )
    SELECT DISTINCT
      eligible_project_judgment.project_id,
      (
        SELECT active_generation
        FROM app.project_review_serving_generation
        WHERE project_id = ${projectLiteral}
      ) AS generation,
      eligible_project_judgment.prompt_id,
      dictionary.answer_id,
      eligible_project_judgment.article_id,
      eligible_project_judgment.article_created_at,
      dictionary.numeric_answer_value,
      current_timestamp
    FROM eligible_project_judgment,
      UNNEST(eligible_project_judgment.normalized_answers) AS answer(answer_value)
    INNER JOIN app.review_answer_dictionary dictionary
      ON dictionary.project_id = eligible_project_judgment.project_id
     AND dictionary.prompt_id = eligible_project_judgment.prompt_id
     AND dictionary.answer_value = TRIM(answer.answer_value)
    WHERE eligible_project_judgment.normalized_answers IS NOT NULL
      AND ARRAY_LENGTH(eligible_project_judgment.normalized_answers) > 0
      AND NULLIF(TRIM(answer.answer_value), '') IS NOT NULL;

    DELETE FROM mart.review_article_serving_detail
    WHERE project_id = ${projectLiteral}
      AND article_id = ${articleLiteral}
      AND generation = (
        SELECT active_generation
        FROM app.project_review_serving_generation
        WHERE project_id = ${projectLiteral}
      );

    INSERT INTO mart.review_article_serving_detail (
      project_id,
      generation,
      article_id,
      prompt_id,
      prompt_order,
      judgment_id,
      created_at,
      article_created_at,
      article_updated_at,
      model_id,
      answered_original,
      answered_original_as_array,
      detail_updated_at
    )
    WITH article_scope AS (
      SELECT aggregated_scope.project_id, aggregated_scope.article_id, article.article_created_at, article.article_updated_at
      FROM (
        SELECT combined_scope.project_id, combined_scope.article_id
        FROM (
          SELECT pir.project_id, air.article_id
          FROM app.project_import_route pir
          INNER JOIN app.article_import_route air ON air.import_route_id = pir.import_route_id
          WHERE pir.project_id = ${projectLiteral}
            AND air.article_id = ${articleLiteral}
          UNION ALL
          SELECT pa.project_id, pa.article_id
          FROM app.project_article pa
          WHERE pa.project_id = ${projectLiteral}
            AND pa.article_id = ${articleLiteral}
        ) combined_scope
        GROUP BY combined_scope.project_id, combined_scope.article_id
      ) aggregated_scope
      INNER JOIN app.project project
        ON project.id = aggregated_scope.project_id
       AND project.archived = FALSE
      INNER JOIN app.article article ON article.id = aggregated_scope.article_id
    )
    SELECT
      article_scope.project_id,
      (
        SELECT active_generation
        FROM app.project_review_serving_generation
        WHERE project_id = ${projectLiteral}
      ) AS generation,
      judgment_fact.article_id,
      judgment_fact.prompt_id,
      project_prompt.prompt_order,
      judgment_fact.judgment_id,
      judgment_fact.created_at,
      judgment_fact.article_created_at,
      judgment_fact.article_updated_at,
      judgment_fact.model_id,
      judgment_fact.answered_original,
      judgment_fact.answered_original_as_array,
      current_timestamp
    FROM article_scope
    INNER JOIN app.project project ON project.id = article_scope.project_id
    INNER JOIN app.project_prompt project_prompt
      ON project_prompt.project_id = article_scope.project_id
     AND project_prompt.enabled = TRUE
    INNER JOIN mart.judgment_fact judgment_fact
     ON judgment_fact.article_id = article_scope.article_id
     AND judgment_fact.prompt_id = project_prompt.prompt_id
     AND judgment_fact.model_id = project.model_id
     AND judgment_fact.use_title = project.use_title
     AND judgment_fact.use_abstract = project.use_abstract
     AND judgment_fact.use_fulltext = project.use_fulltext
     AND judgment_fact.use_fulltext_no_images = project.use_fulltext_no_images;
    COMMIT;
  `
}

const refreshProjectArticleServing = async (projectId: string, articleId: string): Promise<void> => {
  return (await getHasActiveProjectReviewServingGeneration(projectId))
    ? runMartRefreshBackgroundStatement(getProjectArticleServingRefreshSql(projectId, articleId)).then(() => {
        return yieldToEventLoop()
      })
    : refreshProject(projectId)
}

const refreshProjectsForArticle = async (projectIds: string[], articleId: string): Promise<void> => {
  const [currentProjectId = ''] = projectIds

  if (!currentProjectId) {
    return
  }

  await refreshProjectArticleServing(currentProjectId, articleId)
  return refreshProjectsForArticle(projectIds.slice(1), articleId)
}

const refreshQueuedArticleTasks = async (articleIds: string[]): Promise<void> => {
  const [currentArticleId = ''] = articleIds

  if (!currentArticleId) {
    return
  }

  await refreshJudgmentArticle(currentArticleId)
  await refreshProjectsForArticle(await getImpactedProjectIdsForArticle(currentArticleId), currentArticleId)
  setProcessingArticleRefreshes(articleIds.slice(1))
  return refreshQueuedArticleTasks(articleIds.slice(1))
}

const refreshProject = async (projectId: string) => {
  await ensureReviewArticleRollupTable()

  const statements = getProjectRefreshSql(projectId)
  const [currentStatement = ''] = statements

  if (!currentStatement) {
    return
  }

  await runMartRefreshBackgroundStatement(currentStatement)
  await refreshProjectStatements(projectId, statements.slice(1))
  return recordProjectRefreshCompletion()
}

const refreshProjectStatements = async (projectId: string, statements: string[]): Promise<void> => {
  const [currentStatement = ''] = statements

  if (!currentStatement) {
    return
  }

  await runMartRefreshBackgroundStatement(currentStatement)
  await yieldToEventLoop()
  return refreshProjectStatements(projectId, statements.slice(1))
}

const refreshJudgmentArticle = async (articleId: string) => {
  await runMartRefreshBackgroundStatement(getJudgmentArticleRefreshSql(articleId))
  await yieldToEventLoop()
  recordArticleRefreshCompletion()
}

const refreshProjects = async (projectIds: string[]): Promise<void> => {
  const [currentProjectId = ''] = projectIds

  if (!currentProjectId) {
    return
  }

  await refreshProject(currentProjectId)
  setProcessingProjectRefreshes(projectIds.slice(1))
  return refreshProjects(projectIds.slice(1))
}

const processQueuedMartRefreshPass = async (): Promise<boolean> => {
  updateMartRefreshDebugSnapshot({
    lastPassStartedAt: new Date().toISOString(),
    passCount: martRefreshDebugSnapshot.passCount + 1,
  })
  await ensureKnownNoopQueuedProjectRefreshesPruned()
  const [queuedArticleTasks, queuedProjectTasks] = await Promise.all([getQueuedArticleTasks(), getQueuedProjectTasks()])
  const queuedTasks = [...queuedArticleTasks, ...queuedProjectTasks]
  updateMartRefreshDebugSnapshot({lastQueuedTaskCount: queuedTasks.length})

  if (queuedTasks.length === 0) {
    updateMartRefreshDebugSnapshot({lastHasMoreQueuedTasks: false, lastPassCompletedAt: new Date().toISOString()})
    return false
  }

  const claimedQueuedArticleIds = getUniqueValues(
    queuedArticleTasks.map((task) => {
      return task.articleId
    }),
  )
  const claimedQueuedProjectIds = getUniqueValues(
    queuedProjectTasks.map((task) => {
      return task.projectId
    }),
  )

  setClaimedQueuedRefreshes(claimedQueuedArticleIds, claimedQueuedProjectIds)

  try {
    await refreshQueuedArticleTasks(claimedQueuedArticleIds)
    await completeQueuedTasks(queuedArticleTasks)
    setMartRefreshProgressSnapshot({
      claimedQueuedArticleIds: [],
      claimedQueuedProjectIds,
      processingArticleIds: [],
      processingProjectIds: claimedQueuedProjectIds,
    })
    await refreshProjects(claimedQueuedProjectIds)
    await completeQueuedTasks(queuedProjectTasks)

    const hasMoreQueuedTasks = await getHasQueuedTasks()

    updateMartRefreshDebugSnapshot({
      lastHasMoreQueuedTasks: hasMoreQueuedTasks,
      lastPassCompletedAt: new Date().toISOString(),
    })
    return hasMoreQueuedTasks
  } catch (error) {
    updateMartRefreshDebugSnapshot({
      lastErrorAt: new Date().toISOString(),
      lastErrorMessage: error instanceof Error ? error.message : String(error),
    })
    throw error
  } finally {
    resetMartRefreshProgressSnapshot()
  }
}

const yieldToEventLoop = async (): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, martRefreshYieldDelayMs)
  })
}

const continueQueuedMartRefreshesAfterYield = async (): Promise<void> => {
  await yieldToEventLoop()
  return processQueuedMartRefreshesWithinBudget(Date.now() + martRefreshDrainBudgetMs)
}

const processQueuedMartRefreshesWithinBudget = async (deadlineMs: number): Promise<void> => {
  const hasMoreQueuedTasks = await processQueuedMartRefreshPass()

  if (!hasMoreQueuedTasks) {
    return
  }

  return Date.now() >= deadlineMs
    ? continueQueuedMartRefreshesAfterYield()
    : processQueuedMartRefreshesWithinBudget(deadlineMs)
}

const processQueuedMartRefreshes = async (): Promise<void> => {
  return processQueuedMartRefreshesWithinBudget(Date.now() + martRefreshDrainBudgetMs)
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
  updateMartRefreshDebugSnapshot({drainTimerActive: true})
}

const queueMartRefreshTasks = async (tasks: QueueMartRefreshTask[]) => {
  if (tasks.length === 0) {
    return
  }

  await ensureMartRefreshQueueSchema()

  await getAppDatabaseService().run(`
    INSERT INTO app.mart_refresh_queue (
      id,
      refresh_scope,
      project_id,
      article_id,
      project_key,
      article_key,
      refresh_generation,
      reason,
      created_at,
      updated_at
    )
    VALUES ${tasks
      .map((task) => {
        const projectId = task.projectId ?? null
        const articleId = task.articleId ?? null
        return `(${getQuotedStringList([randomUUID(), task.refreshScope]).join(', ')}, ${getSqlLiteral(projectId)}, ${getSqlLiteral(articleId)}, ${getSqlLiteral(projectId ?? '')}, ${getSqlLiteral(articleId ?? '')}, 0, ${getSqlLiteral(task.reason)}, NOW(), NOW())`
      })
      .join(', ')}
    ON CONFLICT(refresh_scope, project_key, article_key) DO UPDATE SET
      completed_at = NULL,
      created_at = CASE
        WHEN app.mart_refresh_queue.completed_at IS NULL THEN app.mart_refresh_queue.created_at
        ELSE NOW()
      END,
      refresh_generation = COALESCE(app.mart_refresh_queue.refresh_generation, 0) + 1,
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

  updateMartRefreshDebugSnapshot({
    drainPromiseActive: true,
    drainTimerActive: false,
    flushInvocationCount: martRefreshDebugSnapshot.flushInvocationCount + 1,
    lastFlushAt: new Date().toISOString(),
  })

  martRefreshDrainPromise = processQueuedMartRefreshes().finally(async () => {
    martRefreshDrainPromise = null
    updateMartRefreshDebugSnapshot({drainPromiseActive: false})

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
    FROM app.project_import_route project_import_route
    INNER JOIN app.project project ON project.id = project_import_route.project_id
    WHERE import_route_id IN (${getQuotedStringList(getUniqueValues(importRouteIds)).join(', ')})
      AND project.archived = FALSE
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
    FROM app.project_prompt project_prompt
    INNER JOIN app.project project ON project.id = project_prompt.project_id
    WHERE prompt_id IN (${getQuotedStringList(getUniqueValues(promptIds)).join(', ')})
      AND project.archived = FALSE
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
  ensureQueueSchema: ensureMartRefreshQueueSchema,
  flush: flushQueuedMartRefreshes,
  getQueuedArticleTasksSqlForTests: getQueuedArticleTasksSql,
  getQueuedProjectTasksSqlForTests: getQueuedProjectTasksSql,
  isAutoDrainEnabled: isMartRefreshAutoDrainEnabled,
  getDebugSnapshot: getMartRefreshDebugSnapshot,
  getProgressSnapshot: getMartRefreshProgressSnapshot,
  getThroughputSnapshot: getMartRefreshThroughputSnapshot,
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
  resetProgressSnapshotForTests: () => {
    martRefreshQueueCompletedAtColumnReady = null
    martRefreshQueueCompletedAtColumnVerified = false
    martRefreshQueueGenerationColumnReady = null
    martRefreshQueueGenerationColumnVerified = false
    martRefreshKnownNoopQueueRowsReady = null
    martRefreshKnownNoopQueueRowsVerified = false
    martRefreshReviewArticleRollupReady = null
    martRefreshReviewArticleRollupVerified = false
    resetMartRefreshDebugSnapshot()
    setMartRefreshAutoDrainEnabled(true)
    resetMartRefreshProgressSnapshot()
    resetMartRefreshThroughputSnapshot()
  },
  setAutoDrainEnabledForTests: setMartRefreshAutoDrainEnabled,
  setProgressSnapshotForTests: setMartRefreshProgressSnapshot,
}

export const getDuckdbMartRefreshService = () => {
  return duckdbMartRefreshService
}
