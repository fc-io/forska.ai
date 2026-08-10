import {getReviewServingFilteredCountSignature} from '../src/server/reviewServing/reviewServingFilteredCountService.ts'
import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {getSqlLiteral} from '../src/server/services/appQueryHelpers.ts'
import {getMaintenanceDuckdbWorkloadContext} from '../src/server/utils/duckdbService.ts'

type CountValue = number | string | null

type ProjectCountRow = {
  activeSnapshotCount?: CountValue
  both?: CountValue
  detailArticleCount?: CountValue
  human?: CountValue
  llm?: CountValue
  projectId: string
  projectName?: string | null
  reviewPageArticleCount?: CountValue
  searchArticleCount?: CountValue
  sourceArticleCount?: CountValue
  unassessed?: CountValue
}

type CacheCountRow = {countValue: CountValue; listModeKey: string; projectId: string}

type ComparableCounts = {both: number; human: number; llm: number; unassessed: number}

type ProjectReport = {
  activeSnapshotCount: number
  cache: Partial<ComparableCounts>
  detail: ComparableCounts
  mart: ComparableCounts
  projectId: string
  projectName: string
  readiness: {
    detailArticleCount: number
    reviewPageArticleCount: number
    searchArticleCount: number
    sourceArticleCount: number
  }
  source: ComparableCounts
}

const listModeKeys = ['llm', 'human', 'both', 'unassessed'] as const

const getNumber = (value: CountValue | undefined) => {
  return Number(value ?? 0)
}

const getComparableCounts = (row: ProjectCountRow): ComparableCounts => {
  return {
    both: getNumber(row.both),
    human: getNumber(row.human),
    llm: getNumber(row.llm),
    unassessed: getNumber(row.unassessed),
  }
}

const getProjectIdListSql = (projectIds: readonly string[]) => {
  return projectIds.map(getSqlLiteral).join(', ')
}

const getSourceCountRows = async (projectIds: readonly string[]) => {
  const projectIdList = getProjectIdListSql(projectIds)
  const database = getAppDatabaseService()
  const workloadContext = getMaintenanceDuckdbWorkloadContext('review-serving-current-db-tab-count-source-parity')

  return database.queryJson<ProjectCountRow>(
    `
    WITH active_project AS (
      SELECT
        project.id AS project_id,
        project.name AS project_name,
        project.model_id,
        project.use_title,
        project.use_abstract,
        project.use_fulltext,
        project.use_fulltext_no_images,
        COALESCE(project.human_judgment_mode, 'prompt') AS human_judgment_mode
      FROM app.project project
      WHERE project.id IN (${projectIdList})
        AND NOT project.archived
        AND project.delete_pending_at IS NULL
    ),
    source_article AS (
      SELECT project_article.project_id, project_article.article_id
      FROM app.project_article project_article
      INNER JOIN active_project project
        ON project.project_id = project_article.project_id
      INNER JOIN app.article article
        ON article.id = project_article.article_id
    ),
    enabled_prompt AS (
      SELECT
        project_prompt.project_id,
        project_prompt.prompt_id
      FROM app.project_prompt project_prompt
      INNER JOIN app.prompt prompt
        ON prompt.id = project_prompt.prompt_id
      WHERE project_prompt.project_id IN (${projectIdList})
        AND project_prompt.enabled
        AND NOT project_prompt.archived
        AND COALESCE(prompt.archived, FALSE) = FALSE
    ),
    enabled_prompt_count AS (
      SELECT project_id, COUNT(DISTINCT prompt_id) AS prompt_count
      FROM enabled_prompt
      GROUP BY project_id
    ),
    latest_llm_judgment AS (
      SELECT
        source_article.project_id,
        source_article.article_id,
        enabled_prompt.prompt_id,
        judgment.is_answered,
        judgment.answered_original,
        judgment.answered_original_as_array,
        ROW_NUMBER() OVER (
          PARTITION BY source_article.project_id, source_article.article_id, enabled_prompt.prompt_id
          ORDER BY judgment.created_at DESC NULLS LAST, judgment.id DESC
        ) AS judgment_rank
      FROM source_article
      INNER JOIN active_project project
        ON project.project_id = source_article.project_id
      INNER JOIN enabled_prompt
        ON enabled_prompt.project_id = source_article.project_id
      LEFT JOIN app."judgment" judgment
        ON judgment.article_id = source_article.article_id
       AND judgment.prompt_id = enabled_prompt.prompt_id
       AND judgment.model_id = project.model_id
       AND judgment.use_title = project.use_title
       AND judgment.use_abstract = project.use_abstract
       AND judgment.use_fulltext = project.use_fulltext
       AND judgment.use_fulltext_no_images = project.use_fulltext_no_images
       AND judgment.deleted_at IS NULL
    ),
    llm_article_status AS (
      SELECT
        project_id,
        article_id,
        COUNT(DISTINCT prompt_id) FILTER (
          WHERE judgment_rank = 1
            AND (
              COALESCE(is_answered, FALSE)
              OR answered_original IS NOT NULL
              OR COALESCE(LENGTH(answered_original_as_array), 0) > 0
            )
        ) AS answered_prompt_count
      FROM latest_llm_judgment
      WHERE judgment_rank = 1
      GROUP BY project_id, article_id
    ),
    human_prompt_status AS (
      SELECT
        source_article.project_id,
        source_article.article_id,
        COUNT(DISTINCT enabled_prompt.prompt_id) FILTER (WHERE judgment_human.id IS NOT NULL) AS answered_prompt_count
      FROM source_article
      INNER JOIN active_project project
        ON project.project_id = source_article.project_id
       AND project.human_judgment_mode <> 'summary'
      INNER JOIN enabled_prompt
        ON enabled_prompt.project_id = source_article.project_id
      LEFT JOIN app."judgment_human" judgment_human
        ON judgment_human.project_id IS NOT DISTINCT FROM source_article.project_id
       AND judgment_human.article_id = source_article.article_id
       AND judgment_human.prompt_id = enabled_prompt.prompt_id
      GROUP BY source_article.project_id, source_article.article_id
    ),
    human_summary_status AS (
      SELECT
        source_article.project_id,
        source_article.article_id,
        BOOL_OR(NULLIF(TRIM(COALESCE(judgment_human_summary.answer, '')), '') IS NOT NULL) AS answered
      FROM source_article
      INNER JOIN active_project project
        ON project.project_id = source_article.project_id
       AND project.human_judgment_mode = 'summary'
      LEFT JOIN app."judgment_human_summary" judgment_human_summary
        ON judgment_human_summary.project_id = source_article.project_id
       AND judgment_human_summary.article_id = source_article.article_id
      GROUP BY source_article.project_id, source_article.article_id
    ),
    article_truth AS (
      SELECT
        source_article.project_id,
        source_article.article_id,
        COALESCE(enabled_prompt_count.prompt_count, 0) AS prompt_count,
        COALESCE(llm_article_status.answered_prompt_count, 0) AS llm_answered_prompt_count,
        CASE
          WHEN project.human_judgment_mode = 'summary'
          THEN COALESCE(human_summary_status.answered, FALSE)
          WHEN COALESCE(enabled_prompt_count.prompt_count, 0) = 0
          THEN FALSE
          ELSE COALESCE(human_prompt_status.answered_prompt_count, 0) = enabled_prompt_count.prompt_count
        END AS human_answered
      FROM source_article
      INNER JOIN active_project project
        ON project.project_id = source_article.project_id
      LEFT JOIN enabled_prompt_count
        ON enabled_prompt_count.project_id = source_article.project_id
      LEFT JOIN llm_article_status
        ON llm_article_status.project_id = source_article.project_id
       AND llm_article_status.article_id = source_article.article_id
      LEFT JOIN human_prompt_status
        ON human_prompt_status.project_id = source_article.project_id
       AND human_prompt_status.article_id = source_article.article_id
      LEFT JOIN human_summary_status
        ON human_summary_status.project_id = source_article.project_id
       AND human_summary_status.article_id = source_article.article_id
    )
    SELECT
      active_project.project_id AS projectId,
      active_project.project_name AS projectName,
      COUNT(*) AS sourceArticleCount,
      COUNT(*) FILTER (WHERE article_truth.llm_answered_prompt_count > 0) AS llm,
      COUNT(*) FILTER (WHERE article_truth.human_answered) AS human,
      COUNT(*) FILTER (
        WHERE article_truth.human_answered
          AND article_truth.prompt_count > 0
          AND article_truth.llm_answered_prompt_count = article_truth.prompt_count
      ) AS both,
      COUNT(*) FILTER (
        WHERE article_truth.prompt_count = 0
          OR article_truth.llm_answered_prompt_count < article_truth.prompt_count
      ) AS unassessed
    FROM article_truth
    INNER JOIN active_project
      ON active_project.project_id = article_truth.project_id
    GROUP BY active_project.project_id, active_project.project_name
    ORDER BY active_project.project_name ASC
  `,
    workloadContext,
  )
}

const getMartCountRows = async (projectIds: readonly string[]) => {
  const projectIdList = getProjectIdListSql(projectIds)
  const database = getAppDatabaseService()
  const workloadContext = getMaintenanceDuckdbWorkloadContext('review-serving-current-db-tab-count-mart-parity')

  return database.queryJson<ProjectCountRow>(
    `
    WITH active_snapshot AS (
      SELECT project_id, snapshot_id, review_config_hash
      FROM app.review_serving_snapshot_manifest
      WHERE project_id IN (${projectIdList})
        AND snapshot_status = 'active'
    ),
    list_state AS (
      SELECT state.*
      FROM mart.review_article_serving_list_mode_state_v4 state
      INNER JOIN active_snapshot snapshot
        ON snapshot.project_id = state.project_id
       AND snapshot.snapshot_id = state.snapshot_id
       AND snapshot.review_config_hash = state.review_config_hash
    ),
    queue_state AS (
      SELECT queue.*
      FROM mart.review_unassessed_queue_article_rank_serving_v4 queue
      INNER JOIN active_snapshot snapshot
        ON snapshot.project_id = queue.project_id
       AND snapshot.snapshot_id = queue.snapshot_id
       AND snapshot.review_config_hash = queue.review_config_hash
      WHERE queue.queue_kind = 'unassessed'
    ),
    detail_state AS (
      SELECT detail.*
      FROM mart.review_article_judgment_detail_serving_v4 detail
      INNER JOIN active_snapshot snapshot
        ON snapshot.project_id = detail.project_id
       AND snapshot.snapshot_id = detail.snapshot_id
       AND snapshot.review_config_hash = detail.review_config_hash
    ),
    search_state AS (
      SELECT search.project_id, search.snapshot_id, search_article_id.article_id
      FROM mart.review_title_search_serving_v4 search
      INNER JOIN active_snapshot snapshot
        ON snapshot.project_id = search.project_id
       AND snapshot.snapshot_id = search.snapshot_id
      CROSS JOIN UNNEST(search.article_ids) AS search_article_id(article_id)
    ),
    detail_article AS (
      SELECT project_id, COUNT(DISTINCT article_id) AS detail_article_count
      FROM detail_state
      GROUP BY project_id
    ),
    search_article AS (
      SELECT project_id, COUNT(DISTINCT article_id) AS search_article_count
      FROM search_state
      GROUP BY project_id
    )
    SELECT
      project.id AS projectId,
      project.name AS projectName,
      COUNT(DISTINCT active_snapshot.snapshot_id) AS activeSnapshotCount,
      COUNT(DISTINCT list_state.article_id) AS reviewPageArticleCount,
      COALESCE(MAX(detail_article.detail_article_count), 0) AS detailArticleCount,
      COALESCE(MAX(search_article.search_article_count), 0) AS searchArticleCount,
      COUNT(DISTINCT list_state.article_id) FILTER (WHERE list_state.llm_has_judgment) AS llm,
      COUNT(DISTINCT list_state.article_id) FILTER (WHERE list_state.human_status = 'answered') AS human,
      COUNT(DISTINCT list_state.article_id) FILTER (
        WHERE list_state.human_status = 'answered'
          AND list_state.llm_status = 'answered'
      ) AS both,
      COUNT(DISTINCT queue_state.article_id) AS unassessed
    FROM app.project project
    LEFT JOIN active_snapshot
      ON active_snapshot.project_id = project.id
    LEFT JOIN list_state
      ON list_state.project_id = project.id
    LEFT JOIN queue_state
      ON queue_state.project_id = project.id
    LEFT JOIN detail_article
      ON detail_article.project_id = project.id
    LEFT JOIN search_article
      ON search_article.project_id = project.id
    WHERE project.id IN (${projectIdList})
    GROUP BY project.id, project.name
    ORDER BY project.name ASC
  `,
    workloadContext,
  )
}

const getDetailCountRows = async (projectIds: readonly string[]) => {
  const projectIdList = getProjectIdListSql(projectIds)
  const database = getAppDatabaseService()
  const workloadContext = getMaintenanceDuckdbWorkloadContext('review-serving-current-db-tab-count-detail-parity')

  return database.queryJson<ProjectCountRow>(
    `
    WITH active_snapshot AS (
      SELECT project_id, snapshot_id, review_config_hash
      FROM app.review_serving_snapshot_manifest
      WHERE project_id IN (${projectIdList})
        AND snapshot_status = 'active'
    ),
    detail_article AS (
      SELECT
        detail.project_id,
        detail.article_id,
        COUNT(*) FILTER (WHERE detail.payload_kind = 'llm') AS llm_prompt_count,
        COUNT(*) FILTER (WHERE detail.payload_kind = 'llm' AND COALESCE(detail.is_answered, FALSE)) AS llm_answered_count,
        BOOL_OR(detail.payload_kind = 'human' AND COALESCE(detail.is_answered, FALSE)) AS human_answered
      FROM mart.review_article_judgment_detail_serving_v4 detail
      INNER JOIN active_snapshot snapshot
        ON snapshot.project_id = detail.project_id
       AND snapshot.snapshot_id = detail.snapshot_id
       AND snapshot.review_config_hash = detail.review_config_hash
      GROUP BY detail.project_id, detail.article_id
    )
    SELECT
      project_id AS projectId,
      COUNT(*) FILTER (WHERE llm_answered_count > 0) AS llm,
      COUNT(*) FILTER (WHERE human_answered) AS human,
      COUNT(*) FILTER (WHERE human_answered AND llm_prompt_count > 0 AND llm_answered_count = llm_prompt_count) AS both,
      COUNT(*) FILTER (WHERE llm_prompt_count = 0 OR llm_answered_count < llm_prompt_count) AS unassessed
    FROM detail_article
    GROUP BY project_id
  `,
    workloadContext,
  )
}

const getCacheCountRows = async (projectIds: readonly string[]) => {
  const projectIdList = getProjectIdListSql(projectIds)
  const listAllFilterSignature = getReviewServingFilteredCountSignature({filters: {}, searchTokenPrefixes: []})
  const database = getAppDatabaseService()
  const workloadContext = getMaintenanceDuckdbWorkloadContext('review-serving-current-db-tab-count-cache-parity')

  return database.queryJson<CacheCountRow>(
    `
    SELECT
      cache.project_id AS projectId,
      cache.list_mode_key AS listModeKey,
      cache.count_value AS countValue
    FROM mart.review_filtered_count_serving_v4 cache
    INNER JOIN app.review_serving_snapshot_manifest snapshot
      ON snapshot.project_id = cache.project_id
     AND snapshot.snapshot_id = cache.snapshot_id
     AND snapshot.review_config_hash = cache.review_config_hash
     AND snapshot.snapshot_status = 'active'
    WHERE cache.project_id IN (${projectIdList})
      AND cache.filter_signature = ${getSqlLiteral(listAllFilterSignature)}
      AND cache.list_mode_key IN (${listModeKeys.map(getSqlLiteral).join(', ')})
  `,
    workloadContext,
  )
}

const getActiveProjectIds = async () => {
  const database = getAppDatabaseService()
  const workloadContext = getMaintenanceDuckdbWorkloadContext('review-serving-current-db-tab-count-projects')
  const rows = await database.queryJson<{projectId: string}>(
    `
    SELECT id AS projectId
    FROM app.project
    WHERE NOT archived
      AND delete_pending_at IS NULL
    ORDER BY name ASC, id ASC
  `,
    workloadContext,
  )

  return rows.map((row) => {
    return row.projectId
  })
}

const getReport = async (): Promise<ProjectReport[]> => {
  const projectIds = await getActiveProjectIds()

  if (projectIds.length === 0) {
    return []
  }

  const [sourceRows, martRows, detailRows, cacheRows] = await Promise.all([
    getSourceCountRows(projectIds),
    getMartCountRows(projectIds),
    getDetailCountRows(projectIds),
    getCacheCountRows(projectIds),
  ])
  const detailByProject = new Map(
    detailRows.map((row) => {
      return [row.projectId, getComparableCounts(row)]
    }),
  )
  const martByProject = new Map(
    martRows.map((row) => {
      return [row.projectId, row]
    }),
  )
  const cacheByProject = new Map<string, Partial<ComparableCounts>>()

  cacheRows.forEach((row) => {
    const cache = cacheByProject.get(row.projectId) ?? {}
    cache[row.listModeKey as keyof ComparableCounts] = getNumber(row.countValue)
    cacheByProject.set(row.projectId, cache)
  })

  return sourceRows.map((sourceRow) => {
    const martRow = martByProject.get(sourceRow.projectId) ?? {projectId: sourceRow.projectId}

    return {
      activeSnapshotCount: getNumber(martRow.activeSnapshotCount),
      cache: cacheByProject.get(sourceRow.projectId) ?? {},
      detail: detailByProject.get(sourceRow.projectId) ?? {both: 0, human: 0, llm: 0, unassessed: 0},
      mart: getComparableCounts(martRow),
      projectId: sourceRow.projectId,
      projectName: sourceRow.projectName ?? sourceRow.projectId,
      readiness: {
        detailArticleCount: getNumber(martRow.detailArticleCount),
        reviewPageArticleCount: getNumber(martRow.reviewPageArticleCount),
        searchArticleCount: getNumber(martRow.searchArticleCount),
        sourceArticleCount: getNumber(sourceRow.sourceArticleCount),
      },
      source: getComparableCounts(sourceRow),
    }
  })
}

const getMismatches = (report: ProjectReport) => {
  const mismatches: string[] = []

  if (report.activeSnapshotCount !== 1) {
    mismatches.push(`expected exactly one active snapshot, found ${report.activeSnapshotCount}`)
  }

  if (report.readiness.reviewPageArticleCount !== report.readiness.sourceArticleCount) {
    mismatches.push(
      `review page article count ${report.readiness.reviewPageArticleCount} != source article count ${report.readiness.sourceArticleCount}`,
    )
  }

  if (report.readiness.detailArticleCount !== report.readiness.sourceArticleCount) {
    mismatches.push(
      `detail article count ${report.readiness.detailArticleCount} != source article count ${report.readiness.sourceArticleCount}`,
    )
  }

  listModeKeys.forEach((key) => {
    if (report.mart[key] !== report.source[key]) {
      mismatches.push(`mart ${key} count ${report.mart[key]} != source count ${report.source[key]}`)
    }

    if (key !== 'unassessed' && report.detail[key] !== report.source[key]) {
      mismatches.push(`detail ${key} count ${report.detail[key]} != source count ${report.source[key]}`)
    }

    const cacheValue = report.cache[key]
    if (cacheValue !== undefined && cacheValue !== report.mart[key]) {
      mismatches.push(`cached ${key} count ${cacheValue} != mart count ${report.mart[key]}`)
    }
  })

  return mismatches
}

const main = async () => {
  const report = await getReport()
  const failures = report.flatMap((project) => {
    const mismatches = getMismatches(project)

    return mismatches.length === 0 ? [] : [{...project, mismatches}]
  })

  console.log(JSON.stringify({failures, projects: report}, null, 2))

  if (failures.length > 0) {
    throw new Error(`review-serving tab-count parity failed for ${failures.length} project(s)`)
  }
}

await main()
