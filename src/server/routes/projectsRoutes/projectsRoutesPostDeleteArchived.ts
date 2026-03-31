import {Elysia, t} from 'elysia'

import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getQuotedStringList} from '../../services/appQueryHelpers.ts'
import {archivedProjectMartTableNames} from '../../services/getDuckdbMartRefreshService.ts'
import {assertArchivedProjectCleanupProjectForeignKeysTx} from './projectsRoutesPostDeleteArchivedProjectForeignKeys.ts'

type AppTx = {queryJson: <T>(statement: string) => Promise<T[]>; run: (statement: string) => Promise<void>}

type ProjectArchivedStateRow = {id: string; archived: boolean}
type JudgmentJobStateRow = {projectId: string; status: string}

const terminalJudgmentJobStatuses = ['completed', 'failed', 'project_removed']

const tokenUseCreateSql = `
  CREATE TABLE app.token_use (
    id VARCHAR PRIMARY KEY,
    judgment_job_id VARCHAR REFERENCES app.judgment_job(id),
    requests INTEGER NOT NULL,
    total_prompt_tokens BIGINT NOT NULL,
    total_completion_tokens BIGINT NOT NULL,
    total_tokens BIGINT NOT NULL,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    duration BIGINT,
    gpu_nnodes INTEGER,
    gpu_gpus_per_node INTEGER,
    gpu_total_gpus INTEGER,
    tp_size INTEGER,
    dp_size INTEGER,
    gpu_shape VARCHAR,
    sglang_max_running_requests INTEGER,
    sglang_model VARCHAR,
    successful_requests INTEGER,
    failed_requests INTEGER,
    has_failed_requests BOOLEAN,
    failed_requests_details JSON,
    total_success_prompt_tokens BIGINT,
    total_success_completion_tokens BIGINT,
    total_success_tokens BIGINT,
    total_failed_prompt_tokens BIGINT,
    total_failed_completion_tokens BIGINT,
    total_failed_tokens BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
  )
`

const judgmentJobPromptCreateSql = `
  CREATE TABLE app.judgment_job_prompt (
    id VARCHAR PRIMARY KEY,
    job_id VARCHAR NOT NULL REFERENCES app.judgment_job(id),
    article_id VARCHAR NOT NULL REFERENCES app.article(id),
    prompt_id VARCHAR NOT NULL REFERENCES app.prompt(id),
    server_id VARCHAR,
    sent_at TIMESTAMPTZ,
    judged_at TIMESTAMPTZ,
    status VARCHAR NOT NULL DEFAULT 'ready',
    skip_reason VARCHAR,
    created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
    UNIQUE(article_id, prompt_id, job_id)
  )
`

const judgmentJobCreateSql = `
  CREATE TABLE app.judgment_job (
    id VARCHAR PRIMARY KEY,
    project_id VARCHAR NOT NULL REFERENCES app.project(id),
    status VARCHAR NOT NULL,
    error JSON,
    storage_state VARCHAR NOT NULL DEFAULT 'active',
    quarantined_at TIMESTAMPTZ,
    quarantine_reason VARCHAR,
    last_import_started_at TIMESTAMPTZ,
    last_import_completed_at TIMESTAMPTZ,
    last_import_error_at TIMESTAMPTZ,
    last_import_error VARCHAR,
    last_import_exit_code INTEGER,
    import_failure_count INTEGER NOT NULL DEFAULT 0,
    pause_requested_at TIMESTAMPTZ,
    send_to_llm_batch_size INTEGER NOT NULL DEFAULT 5,
    send_to_llm_interval INTEGER NOT NULL DEFAULT 15,
    cursor_last_created_at TIMESTAMPTZ,
    cursor_last_article_id VARCHAR,
    created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
  )
`

const reviewCreateSql = `
  CREATE TABLE app.review (
    id VARCHAR PRIMARY KEY,
    project_id VARCHAR NOT NULL REFERENCES app.project(id),
    article_id VARCHAR NOT NULL REFERENCES app.article(id),
    opened BOOLEAN NOT NULL DEFAULT FALSE,
    reviewed_title BOOLEAN NOT NULL DEFAULT FALSE,
    reviewed_title_comment VARCHAR,
    reviewed_abstract BOOLEAN NOT NULL DEFAULT FALSE,
    reviewed_abstract_comment VARCHAR,
    reviewed_intro BOOLEAN NOT NULL DEFAULT FALSE,
    reviewed_intro_comment VARCHAR,
    reviewed_method BOOLEAN NOT NULL DEFAULT FALSE,
    reviewed_method_comment VARCHAR,
    reviewed_results BOOLEAN NOT NULL DEFAULT FALSE,
    reviewed_results_comment VARCHAR,
    reviewed_discussion BOOLEAN NOT NULL DEFAULT FALSE,
    reviewed_discussion_comment VARCHAR,
    reviewed_conclusion BOOLEAN NOT NULL DEFAULT FALSE,
    reviewed_conclusion_comment VARCHAR,
    reviewed_appendix BOOLEAN NOT NULL DEFAULT FALSE,
    reviewed_appendix_comment VARCHAR,
    reviewed_other BOOLEAN NOT NULL DEFAULT FALSE,
    reviewed_other_comment VARCHAR,
    created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
    UNIQUE(project_id, article_id)
  )
`

const projectImportRouteCreateSql = `
  CREATE TABLE app.project_import_route (
    id VARCHAR PRIMARY KEY,
    project_id VARCHAR NOT NULL REFERENCES app.project(id),
    import_route_id VARCHAR NOT NULL REFERENCES app.import_route(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
    UNIQUE(project_id, import_route_id)
  )
`

const projectArticleCreateSql = `
  CREATE TABLE app.project_article (
    id VARCHAR PRIMARY KEY,
    project_id VARCHAR NOT NULL REFERENCES app.project(id),
    article_id VARCHAR NOT NULL REFERENCES app.article(id),
    imported_from_project_id VARCHAR REFERENCES app.project(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
    UNIQUE(project_id, article_id)
  )
`

const projectPromptCreateSql = `
  CREATE TABLE app.project_prompt (
    id VARCHAR PRIMARY KEY,
    project_id VARCHAR NOT NULL REFERENCES app.project(id),
    prompt_id VARCHAR NOT NULL REFERENCES app.prompt(id),
    prompt_order INTEGER,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    archived BOOLEAN NOT NULL DEFAULT FALSE,
    origin_project_id VARCHAR REFERENCES app.project(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
    UNIQUE(project_id, prompt_id)
  )
`

const judgmentCreateSql = `
  CREATE TABLE app.judgment (
    id VARCHAR PRIMARY KEY,
    article_id VARCHAR NOT NULL REFERENCES app.article(id),
    prompt_id VARCHAR NOT NULL REFERENCES app.prompt(id),
    model_id VARCHAR NOT NULL REFERENCES app.model(id),
    project_id VARCHAR REFERENCES app.project(id),
    snapshot_project_id VARCHAR,
    snapshot_project_model_name VARCHAR,
    use_title BOOLEAN NOT NULL DEFAULT TRUE,
    use_abstract BOOLEAN NOT NULL DEFAULT TRUE,
    use_fulltext BOOLEAN NOT NULL DEFAULT FALSE,
    use_fulltext_no_images BOOLEAN NOT NULL DEFAULT FALSE,
    chunking_strategy VARCHAR,
    is_answered BOOLEAN NOT NULL DEFAULT FALSE,
    answered_original VARCHAR,
    answered_original_as_array VARCHAR[],
    confidence_original INTEGER NOT NULL DEFAULT 50,
    explanation VARCHAR,
    quotes JSON,
    delete_generation BIGINT NOT NULL DEFAULT 0,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
    UNIQUE(article_id, prompt_id, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images, delete_generation)
  )
`

const judgmentAssessmentCreateSql = `
  CREATE TABLE app.judgment_assessment (
    id VARCHAR PRIMARY KEY,
    judgment_id VARCHAR NOT NULL REFERENCES app.judgment(id),
    assessment_is_correct BOOLEAN NOT NULL,
    assessment_comment VARCHAR,
    created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
    UNIQUE(judgment_id)
  )
`

const judgmentHumanCreateSql = `
  CREATE TABLE app.judgment_human (
    id VARCHAR PRIMARY KEY,
    project_id VARCHAR REFERENCES app.project(id),
    article_id VARCHAR NOT NULL REFERENCES app.article(id),
    prompt_id VARCHAR NOT NULL REFERENCES app.prompt(id),
    is_answered BOOLEAN NOT NULL DEFAULT FALSE,
    answer VARCHAR,
    comment VARCHAR,
    created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
    UNIQUE(project_id, article_id, prompt_id)
  )
`

const getUniqueProjectIds = (projectIds: string[]) => {
  return Array.from(
    new Set(
      projectIds.filter((projectId) => {
        return projectId.trim() !== ''
      }),
    ),
  )
}

const runStatements = async (tx: AppTx, statements: string[]) => {
  return statements.reduce<Promise<void>>((promise, statement) => {
    return promise.then(() => {
      return tx.run(statement)
    })
  }, Promise.resolve())
}

const getProjectIdsSql = (projectIds: string[]) => {
  return getQuotedStringList(projectIds).join(', ')
}

const getTempTableName = (prefix: string) => {
  return `temp_${prefix}_${crypto.randomUUID().replaceAll('-', '_')}`
}

const getArchivedProjectPurgeStatements = (projectIdsSql: string) => {
  return archivedProjectMartTableNames.map((tableName) => {
    return `
      DELETE FROM ${tableName}
      WHERE project_id IN (${projectIdsSql})
    `
  })
}

const hasTableTx = async (tx: AppTx, params: {schema: string; table: string}) => {
  const [tableRow] = await tx.queryJson<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM information_schema.tables
    WHERE table_schema = '${params.schema}'
      AND table_name = '${params.table}'
  `)

  return Number(tableRow?.count ?? 0) > 0
}

const rebuildTableTx = async (
  tx: AppTx,
  params: {tableName: string; createSql: string; selectSql: string; tempPrefix: string},
) => {
  const tempTableName = getTempTableName(params.tempPrefix)

  return runStatements(tx, [
    `CREATE TEMP TABLE ${tempTableName} AS ${params.selectSql}`,
    `DROP TABLE ${params.tableName}`,
    params.createSql,
    `INSERT INTO ${params.tableName} SELECT * FROM ${tempTableName}`,
    `DROP TABLE ${tempTableName}`,
  ])
}

const rebuildJudgmentJobGroupTx = async (
  tx: AppTx,
  params: {projectIdsSql: string; hasJudgmentJobPromptTable: boolean},
) => {
  const tokenUseTempTableName = getTempTableName('delete_archived_token_use')
  const judgmentJobPromptTempTableName = getTempTableName('delete_archived_judgment_job_prompt')
  const judgmentJobTempTableName = getTempTableName('delete_archived_judgment_job')

  return runStatements(tx, [
    `
      CREATE TEMP TABLE ${tokenUseTempTableName} AS
      SELECT tu.*
      FROM app.token_use tu
      LEFT JOIN app.judgment_job jj ON jj.id = tu.judgment_job_id
      WHERE jj.project_id NOT IN (${params.projectIdsSql})
         OR tu.judgment_job_id IS NULL
         OR jj.id IS NULL
    `,
    ...(params.hasJudgmentJobPromptTable
      ? [
          `
            CREATE TEMP TABLE ${judgmentJobPromptTempTableName} AS
            SELECT jjp.*
            FROM app.judgment_job_prompt jjp
            LEFT JOIN app.judgment_job jj ON jj.id = jjp.job_id
            WHERE jj.project_id NOT IN (${params.projectIdsSql})
               OR jj.id IS NULL
          `,
        ]
      : []),
    `
      CREATE TEMP TABLE ${judgmentJobTempTableName} AS
      SELECT *
      FROM app.judgment_job
      WHERE project_id NOT IN (${params.projectIdsSql})
    `,
    `DROP TABLE app.token_use`,
    ...(params.hasJudgmentJobPromptTable ? ['DROP TABLE app.judgment_job_prompt'] : []),
    `DROP TABLE app.judgment_job`,
    judgmentJobCreateSql,
    `INSERT INTO app.judgment_job SELECT * FROM ${judgmentJobTempTableName}`,
    tokenUseCreateSql,
    `INSERT INTO app.token_use SELECT * FROM ${tokenUseTempTableName}`,
    ...(params.hasJudgmentJobPromptTable
      ? [
          judgmentJobPromptCreateSql,
          `INSERT INTO app.judgment_job_prompt SELECT * FROM ${judgmentJobPromptTempTableName}`,
        ]
      : []),
    `DROP TABLE ${judgmentJobTempTableName}`,
    `DROP TABLE ${tokenUseTempTableName}`,
    ...(params.hasJudgmentJobPromptTable ? [`DROP TABLE ${judgmentJobPromptTempTableName}`] : []),
  ])
}

const rebuildJudgmentGroupTx = async (tx: AppTx, projectIdsSql: string) => {
  const judgmentAssessmentTempTableName = getTempTableName('delete_archived_judgment_assessment')
  const judgmentTempTableName = getTempTableName('delete_archived_judgment')

  return runStatements(tx, [
    `CREATE TEMP TABLE ${judgmentAssessmentTempTableName} AS SELECT * FROM app.judgment_assessment`,
    `
      CREATE TEMP TABLE ${judgmentTempTableName} AS
      SELECT
        id,
        article_id,
        prompt_id,
        model_id,
        CASE WHEN project_id IN (${projectIdsSql}) THEN NULL ELSE project_id END AS project_id,
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
        confidence_original,
        explanation,
        quotes,
        delete_generation,
        deleted_at,
        created_at,
        updated_at
      FROM app.judgment
    `,
    `DROP TABLE app.judgment_assessment`,
    `DROP TABLE app.judgment`,
    judgmentCreateSql,
    `INSERT INTO app.judgment SELECT * FROM ${judgmentTempTableName}`,
    judgmentAssessmentCreateSql,
    `INSERT INTO app.judgment_assessment SELECT * FROM ${judgmentAssessmentTempTableName}`,
    `DROP TABLE ${judgmentTempTableName}`,
    `DROP TABLE ${judgmentAssessmentTempTableName}`,
  ])
}

const assertAllProjectsExistAndArchived = async (projectIds: string[]) => {
  const projectIdsSql = getProjectIdsSql(projectIds)
  const projectRows = await getAppDatabaseService().queryJson<ProjectArchivedStateRow>(`
    SELECT id, archived
    FROM app.project
    WHERE id IN (${projectIdsSql})
  `)

  if (projectRows.length !== projectIds.length) {
    throw new Error('One or more projects not found')
  }

  const activeProjectIds = projectRows.reduce<string[]>((ids, projectRow) => {
    return projectRow.archived ? ids : [...ids, projectRow.id]
  }, [])

  if (activeProjectIds.length > 0) {
    throw new Error(`Only archived projects can be deleted: ${activeProjectIds.join(', ')}`)
  }
}

const assertAllJudgmentJobsAreTerminal = async (projectIds: string[]) => {
  const projectIdsSql = getProjectIdsSql(projectIds)
  const terminalStatusesSql = getQuotedStringList(terminalJudgmentJobStatuses).join(', ')
  const blockingJobRows = await getAppDatabaseService().queryJson<JudgmentJobStateRow>(`
    SELECT DISTINCT project_id AS projectId, status
    FROM app.judgment_job
    WHERE project_id IN (${projectIdsSql})
      AND status NOT IN (${terminalStatusesSql})
    ORDER BY project_id ASC, status ASC
  `)

  if (blockingJobRows.length > 0) {
    const blockingProjectIds = Array.from(
      new Set(
        blockingJobRows.map((blockingJobRow) => {
          return blockingJobRow.projectId
        }),
      ),
    )

    throw new Error(`Archived project delete requires terminal judgment jobs: ${blockingProjectIds.join(', ')}`)
  }
}

const rebuildProjectDeleteTablesTx = async (tx: AppTx, projectIds: string[]) => {
  const projectIdsSql = getProjectIdsSql(projectIds)
  const hasJudgmentJobPromptTable = await hasTableTx(tx, {schema: 'app', table: 'judgment_job_prompt'})

  await rebuildJudgmentJobGroupTx(tx, {projectIdsSql, hasJudgmentJobPromptTable})

  await rebuildTableTx(tx, {
    createSql: reviewCreateSql,
    selectSql: `
      SELECT *
      FROM app.review
      WHERE project_id NOT IN (${projectIdsSql})
    `,
    tableName: 'app.review',
    tempPrefix: 'delete_archived_review',
  })

  await rebuildTableTx(tx, {
    createSql: projectImportRouteCreateSql,
    selectSql: `
      SELECT *
      FROM app.project_import_route
      WHERE project_id NOT IN (${projectIdsSql})
    `,
    tableName: 'app.project_import_route',
    tempPrefix: 'delete_archived_project_import_route',
  })

  await rebuildTableTx(tx, {
    createSql: projectArticleCreateSql,
    selectSql: `
      SELECT
        id,
        project_id,
        article_id,
        CASE WHEN imported_from_project_id IN (${projectIdsSql}) THEN NULL ELSE imported_from_project_id END AS imported_from_project_id,
        created_at,
        updated_at
      FROM app.project_article
      WHERE project_id NOT IN (${projectIdsSql})
    `,
    tableName: 'app.project_article',
    tempPrefix: 'delete_archived_project_article',
  })

  await rebuildTableTx(tx, {
    createSql: projectPromptCreateSql,
    selectSql: `
      SELECT
        id,
        project_id,
        prompt_id,
        prompt_order,
        enabled,
        archived,
        CASE WHEN origin_project_id IN (${projectIdsSql}) THEN NULL ELSE origin_project_id END AS origin_project_id,
        created_at,
        updated_at
      FROM app.project_prompt
      WHERE project_id NOT IN (${projectIdsSql})
    `,
    tableName: 'app.project_prompt',
    tempPrefix: 'delete_archived_project_prompt',
  })

  await rebuildTableTx(tx, {
    createSql: judgmentHumanCreateSql,
    selectSql: `
      SELECT
        id,
        CASE WHEN project_id IN (${projectIdsSql}) THEN NULL ELSE project_id END AS project_id,
        article_id,
        prompt_id,
        is_answered,
        answer,
        comment,
        created_at,
        updated_at
      FROM app.judgment_human
    `,
    tableName: 'app.judgment_human',
    tempPrefix: 'delete_archived_judgment_human',
  })

  await rebuildJudgmentGroupTx(tx, projectIdsSql)
}

const deleteArchivedProjectsTx = async (tx: AppTx, projectIds: string[]) => {
  const projectIdsSql = getProjectIdsSql(projectIds)

  await assertArchivedProjectCleanupProjectForeignKeysTx(tx)
  await rebuildProjectDeleteTablesTx(tx, projectIds)

  return runStatements(tx, [
    `
      DELETE FROM app.mart_refresh_queue
      WHERE project_id IN (${projectIdsSql})
    `,
    `
      DELETE FROM app.review_answer_dictionary
      WHERE project_id IN (${projectIdsSql})
    `,
    `
      DELETE FROM app.project_review_serving_generation
      WHERE project_id IN (${projectIdsSql})
    `,
    ...getArchivedProjectPurgeStatements(projectIdsSql),
    `
      DELETE FROM app.project
      WHERE id IN (${projectIdsSql})
    `,
  ])
}

export const projectsRoutesPostDeleteArchived = new Elysia().post(
  '/api/projects/delete-archived',
  async ({body}) => {
    const projectIds = getUniqueProjectIds(body.projectIds)

    if (projectIds.length === 0) {
      return {success: true}
    }

    await assertAllProjectsExistAndArchived(projectIds)
    await assertAllJudgmentJobsAreTerminal(projectIds)
    await getAppDatabaseService().transaction(async (tx) => {
      await deleteArchivedProjectsTx(tx, projectIds)
    })

    return {success: true}
  },
  {body: t.Object({projectIds: t.Array(t.String())})},
)
