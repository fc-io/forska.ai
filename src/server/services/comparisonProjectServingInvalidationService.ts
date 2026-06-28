import {getAppDatabaseService} from './appDatabaseService.ts'
import {getSqlLiteral} from './appQueryHelpers.ts'
import {getComparisonProjectServingRebuildService} from './comparisonProjectServingRebuildService.ts'
import {getComparisonProjectServingWorkloadContext} from './comparisonProjectServingWorkloadContext.ts'

type ComparisonProjectServingInvalidationRunner = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

type ComparisonProjectServingInvalidationDatabase = {
  queryJson: <T>(statement: string) => Promise<T[]>
  transaction: <T>(operation: (runner: ComparisonProjectServingInvalidationRunner) => Promise<T>) => Promise<T>
}

type ComparisonProjectServingRebuildService = Pick<
  ReturnType<typeof getComparisonProjectServingRebuildService>,
  'markComparisonProjectsServingStale'
>

type ComparisonProjectServingInvalidationDependencies = {
  database: ComparisonProjectServingInvalidationDatabase
  servingRebuildService: ComparisonProjectServingRebuildService
}

type ComparisonProjectServingInvalidationOptions = Partial<ComparisonProjectServingInvalidationDependencies> & {
  runner?: ComparisonProjectServingInvalidationRunner
}

export type ComparisonProjectLlmJudgmentChange = {
  articleId: string
  modelId: string
  promptId: string
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}

export type ComparisonProjectHumanPromptJudgmentChange = {articleId: string; promptId: string}

export type ComparisonProjectHumanSummaryJudgmentChange = {articleId: string; projectId: string}

type ComparisonProjectIdRow = {comparisonProjectId: string}
const comparisonProjectServingInvalidationWorkloadContext = getComparisonProjectServingWorkloadContext({
  routeOrJobKey: 'comparisonServing.invalidation',
})

const getDefaultComparisonProjectServingInvalidationDependencies =
  (): ComparisonProjectServingInvalidationDependencies => {
    const database = getAppDatabaseService()

    return {
      database: {
        queryJson: (statement) => {
          return database.queryJsonBackground(statement, comparisonProjectServingInvalidationWorkloadContext)
        },
        transaction: (operation) => {
          return database.transaction(operation, comparisonProjectServingInvalidationWorkloadContext)
        },
      },
      servingRebuildService: getComparisonProjectServingRebuildService(),
    }
  }

const getRunnerDatabase = (
  runner: ComparisonProjectServingInvalidationRunner,
): ComparisonProjectServingInvalidationDatabase => {
  return {
    queryJson: runner.queryJson,
    transaction: <T>(operation: (operationRunner: ComparisonProjectServingInvalidationRunner) => Promise<T>) => {
      return operation(runner)
    },
  }
}

const getComparisonProjectServingInvalidationDependencies = (options: ComparisonProjectServingInvalidationOptions) => {
  const defaults = getDefaultComparisonProjectServingInvalidationDependencies()
  const database = options.runner ? getRunnerDatabase(options.runner) : (options.database ?? defaults.database)

  return {database, servingRebuildService: options.servingRebuildService ?? defaults.servingRebuildService}
}

const getUniqueEntries = <T>(entries: readonly T[], getKey: (entry: T) => string) => {
  return Array.from(
    entries
      .reduce<Map<string, T>>((entryMap, entry) => {
        const key = getKey(entry)

        return entryMap.has(key) ? entryMap : entryMap.set(key, entry)
      }, new Map<string, T>())
      .values(),
  )
}

const getLlmJudgmentChangeKey = (change: ComparisonProjectLlmJudgmentChange) => {
  return [
    change.articleId,
    change.promptId,
    change.modelId,
    change.useTitle,
    change.useAbstract,
    change.useFulltext,
    change.useFulltextNoImages,
  ].join('|')
}

const getHumanPromptJudgmentChangeKey = (change: ComparisonProjectHumanPromptJudgmentChange) => {
  return [change.articleId, change.promptId].join('|')
}

const getHumanSummaryJudgmentChangeKey = (change: ComparisonProjectHumanSummaryJudgmentChange) => {
  return [change.articleId, change.projectId].join('|')
}

const getLlmJudgmentChangeCteSql = (changes: ComparisonProjectLlmJudgmentChange[]) => {
  return `
    changed_judgment(
      article_id,
      prompt_id,
      model_id,
      use_title,
      use_abstract,
      use_fulltext,
      use_fulltext_no_images
    ) AS (
      VALUES ${changes
        .map((change) => {
          return `(
            ${getSqlLiteral(change.articleId)},
            ${getSqlLiteral(change.promptId)},
            ${getSqlLiteral(change.modelId)},
            ${getSqlLiteral(change.useTitle)},
            ${getSqlLiteral(change.useAbstract)},
            ${getSqlLiteral(change.useFulltext)},
            ${getSqlLiteral(change.useFulltextNoImages)}
          )`
        })
        .join(', ')}
    )
  `
}

const getHumanPromptJudgmentChangeCteSql = (changes: ComparisonProjectHumanPromptJudgmentChange[]) => {
  return `
    changed_judgment(article_id, prompt_id) AS (
      VALUES ${changes
        .map((change) => {
          return `(${getSqlLiteral(change.articleId)}, ${getSqlLiteral(change.promptId)})`
        })
        .join(', ')}
    )
  `
}

const getHumanSummaryJudgmentChangeCteSql = (changes: ComparisonProjectHumanSummaryJudgmentChange[]) => {
  return `
    changed_judgment(article_id, project_id) AS (
      VALUES ${changes
        .map((change) => {
          return `(${getSqlLiteral(change.articleId)}, ${getSqlLiteral(change.projectId)})`
        })
        .join(', ')}
    )
  `
}

const getComparisonProjectModelOverlapSql = (comparisonProjectAlias: string, changeAlias: string) => {
  return `(
    COALESCE(ARRAY_LENGTH(${comparisonProjectAlias}.model_ids), 0) = 0
    OR list_contains(${comparisonProjectAlias}.model_ids, ${changeAlias}.model_id)
  )`
}

const getComparisonProjectContentOverlapSql = (comparisonProjectAlias: string, changeAlias: string) => {
  return `(
    (
      (${comparisonProjectAlias}.use_title = TRUE OR ${comparisonProjectAlias}.use_abstract = TRUE)
      AND ${changeAlias}.use_title = ${comparisonProjectAlias}.use_title
      AND ${changeAlias}.use_abstract = ${comparisonProjectAlias}.use_abstract
      AND ${changeAlias}.use_fulltext = FALSE
      AND ${changeAlias}.use_fulltext_no_images = FALSE
    )
    OR (
      ${comparisonProjectAlias}.use_fulltext = TRUE
      AND ${changeAlias}.use_title = FALSE
      AND ${changeAlias}.use_abstract = FALSE
      AND ${changeAlias}.use_fulltext = TRUE
      AND ${changeAlias}.use_fulltext_no_images = FALSE
    )
    OR (
      ${comparisonProjectAlias}.use_fulltext_no_images = TRUE
      AND ${changeAlias}.use_title = FALSE
      AND ${changeAlias}.use_abstract = FALSE
      AND ${changeAlias}.use_fulltext = FALSE
      AND ${changeAlias}.use_fulltext_no_images = TRUE
    )
  )`
}

const getComparisonProjectSourceProjectLinkExistsSql = (comparisonProjectAlias: string) => {
  return `EXISTS (
    SELECT 1
    FROM app.comparison_project_source_project cpsp
    WHERE cpsp.comparison_project_id = ${comparisonProjectAlias}.id
  )`
}

const getComparisonProjectImportRouteLinkExistsSql = (comparisonProjectAlias: string) => {
  return `EXISTS (
    SELECT 1
    FROM app.comparison_project_import_route cpir
    WHERE cpir.comparison_project_id = ${comparisonProjectAlias}.id
  )`
}

const getComparisonProjectArticleScopeOverlapSql = (comparisonProjectAlias: string, changeAlias: string) => {
  const sourceProjectLinkExists = getComparisonProjectSourceProjectLinkExistsSql(comparisonProjectAlias)
  const importRouteLinkExists = getComparisonProjectImportRouteLinkExistsSql(comparisonProjectAlias)

  return `(
    EXISTS (
      SELECT 1
      FROM app.comparison_project_source_project cpsp
      INNER JOIN app.project_article pa ON pa.project_id = cpsp.source_project_id
      WHERE cpsp.comparison_project_id = ${comparisonProjectAlias}.id
        AND pa.article_id = ${changeAlias}.article_id
    )
    OR (
      NOT ${sourceProjectLinkExists}
      AND EXISTS (
        SELECT 1
        FROM app.comparison_project_import_route cpir
        INNER JOIN app.article_import_route air ON air.import_route_id = cpir.import_route_id
        WHERE cpir.comparison_project_id = ${comparisonProjectAlias}.id
          AND air.article_id = ${changeAlias}.article_id
      )
    )
    OR (
      NOT ${sourceProjectLinkExists}
      AND NOT ${importRouteLinkExists}
    )
  )`
}

const getComparisonProjectPromptOverlapSql = (comparisonProjectAlias: string, changeAlias: string) => {
  return `EXISTS (
    SELECT 1
    FROM app.comparison_project_prompt cpp
    WHERE cpp.comparison_project_id = ${comparisonProjectAlias}.id
      AND cpp.prompt_id = ${changeAlias}.prompt_id
  )`
}

const getComparisonProjectSummarySourcePromptOverlapSql = (comparisonProjectAlias: string, changeAlias: string) => {
  return `EXISTS (
    SELECT 1
    FROM app.comparison_project_source_project cpsp
    INNER JOIN app.project source_project ON source_project.id = cpsp.source_project_id
    INNER JOIN app.project_prompt pp ON pp.project_id = source_project.id
    WHERE cpsp.comparison_project_id = ${comparisonProjectAlias}.id
      AND source_project.model_id = ${changeAlias}.model_id
      AND pp.prompt_id = ${changeAlias}.prompt_id
      AND pp.enabled = TRUE
      AND pp.criteria_disposition IS NOT NULL
      AND pp.criteria_section_key IS NOT NULL
  )`
}

const getComparisonProjectAnySummarySourcePromptSql = (comparisonProjectAlias: string) => {
  return `EXISTS (
    SELECT 1
    FROM app.comparison_project_source_project cpsp
    INNER JOIN app.project_prompt pp ON pp.project_id = cpsp.source_project_id
    WHERE cpsp.comparison_project_id = ${comparisonProjectAlias}.id
      AND pp.enabled = TRUE
      AND pp.criteria_disposition IS NOT NULL
      AND pp.criteria_section_key IS NOT NULL
  )`
}

const getLlmJudgmentAffectedComparisonProjectIdsSql = (changes: ComparisonProjectLlmJudgmentChange[]) => {
  const modelOverlapSql = getComparisonProjectModelOverlapSql('cp', 'cj')
  const contentOverlapSql = getComparisonProjectContentOverlapSql('cp', 'cj')
  const articleScopeOverlapSql = getComparisonProjectArticleScopeOverlapSql('cp', 'cj')
  const promptOverlapSql = getComparisonProjectPromptOverlapSql('cp', 'cj')
  const summarySourcePromptOverlapSql = getComparisonProjectSummarySourcePromptOverlapSql('cp', 'cj')
  const anySummarySourcePromptSql = getComparisonProjectAnySummarySourcePromptSql('cp')

  return `
    WITH ${getLlmJudgmentChangeCteSql(changes)},
    affected_prompt_mode_project AS (
      SELECT cp.id AS comparisonProjectId
      FROM app.comparison_project cp
      INNER JOIN changed_judgment cj ON TRUE
      WHERE cp.archived = FALSE
        AND NOT (
          cp.compare_with_humans = TRUE
          AND COALESCE(cp.human_judgment_mode, 'prompt') = 'summary'
        )
        AND ${modelOverlapSql}
        AND ${contentOverlapSql}
        AND ${articleScopeOverlapSql}
        AND ${promptOverlapSql}
    ),
    affected_summary_source_project AS (
      SELECT cp.id AS comparisonProjectId
      FROM app.comparison_project cp
      INNER JOIN changed_judgment cj ON TRUE
      WHERE cp.archived = FALSE
        AND cp.compare_with_humans = TRUE
        AND COALESCE(cp.human_judgment_mode, 'prompt') = 'summary'
        AND ${modelOverlapSql}
        AND ${contentOverlapSql}
        AND ${articleScopeOverlapSql}
        AND ${summarySourcePromptOverlapSql}
    ),
    affected_summary_fallback_project AS (
      SELECT cp.id AS comparisonProjectId
      FROM app.comparison_project cp
      INNER JOIN changed_judgment cj ON TRUE
      WHERE cp.archived = FALSE
        AND cp.compare_with_humans = TRUE
        AND COALESCE(cp.human_judgment_mode, 'prompt') = 'summary'
        AND NOT ${anySummarySourcePromptSql}
        AND ${modelOverlapSql}
        AND ${contentOverlapSql}
        AND ${articleScopeOverlapSql}
        AND ${promptOverlapSql}
    )
    SELECT comparisonProjectId FROM affected_prompt_mode_project
    UNION
    SELECT comparisonProjectId FROM affected_summary_source_project
    UNION
    SELECT comparisonProjectId FROM affected_summary_fallback_project
    ORDER BY comparisonProjectId ASC
  `
}

const getHumanPromptJudgmentAffectedComparisonProjectIdsSql = (
  changes: ComparisonProjectHumanPromptJudgmentChange[],
) => {
  const articleScopeOverlapSql = getComparisonProjectArticleScopeOverlapSql('cp', 'cj')
  const promptOverlapSql = getComparisonProjectPromptOverlapSql('cp', 'cj')

  return `
    WITH ${getHumanPromptJudgmentChangeCteSql(changes)}
    SELECT DISTINCT cp.id AS comparisonProjectId
    FROM app.comparison_project cp
    INNER JOIN changed_judgment cj ON TRUE
    WHERE cp.archived = FALSE
      AND cp.compare_with_humans = TRUE
      AND COALESCE(cp.human_judgment_mode, 'prompt') = 'prompt'
      AND ${articleScopeOverlapSql}
      AND ${promptOverlapSql}
    ORDER BY comparisonProjectId ASC
  `
}

const getHumanSummaryJudgmentAffectedComparisonProjectIdsSql = (
  changes: ComparisonProjectHumanSummaryJudgmentChange[],
) => {
  const articleScopeOverlapSql = getComparisonProjectArticleScopeOverlapSql('cp', 'cj')

  return `
    WITH ${getHumanSummaryJudgmentChangeCteSql(changes)}
    SELECT DISTINCT cp.id AS comparisonProjectId
    FROM app.comparison_project cp
    INNER JOIN changed_judgment cj ON TRUE
    WHERE cp.archived = FALSE
      AND cp.compare_with_humans = TRUE
      AND COALESCE(cp.human_judgment_mode, 'prompt') = 'summary'
      AND cp.summary_source_project_id = cj.project_id
      AND ${articleScopeOverlapSql}
    ORDER BY comparisonProjectId ASC
  `
}

const getComparisonProjectIds = (rows: ComparisonProjectIdRow[]) => {
  return rows.map((row) => {
    return row.comparisonProjectId
  })
}

const markComparisonProjectsServingStaleForAffectedRows = async (
  comparisonProjectIds: string[],
  dependencies: ComparisonProjectServingInvalidationDependencies,
) => {
  await dependencies.servingRebuildService.markComparisonProjectsServingStale(comparisonProjectIds, {
    database: dependencies.database,
  })

  return comparisonProjectIds
}

const markComparisonProjectsServingStaleForLlmJudgments = async (
  changes: readonly ComparisonProjectLlmJudgmentChange[],
  options: ComparisonProjectServingInvalidationOptions = {},
) => {
  const uniqueChanges = getUniqueEntries(changes, getLlmJudgmentChangeKey)
  const dependencies = getComparisonProjectServingInvalidationDependencies(options)

  if (uniqueChanges.length === 0) {
    return []
  }

  const rows = await dependencies.database.queryJson<ComparisonProjectIdRow>(
    getLlmJudgmentAffectedComparisonProjectIdsSql(uniqueChanges),
  )

  return markComparisonProjectsServingStaleForAffectedRows(getComparisonProjectIds(rows), dependencies)
}

const markComparisonProjectsServingStaleForHumanPromptJudgments = async (
  changes: readonly ComparisonProjectHumanPromptJudgmentChange[],
  options: ComparisonProjectServingInvalidationOptions = {},
) => {
  const uniqueChanges = getUniqueEntries(changes, getHumanPromptJudgmentChangeKey)
  const dependencies = getComparisonProjectServingInvalidationDependencies(options)

  if (uniqueChanges.length === 0) {
    return []
  }

  const rows = await dependencies.database.queryJson<ComparisonProjectIdRow>(
    getHumanPromptJudgmentAffectedComparisonProjectIdsSql(uniqueChanges),
  )

  return markComparisonProjectsServingStaleForAffectedRows(getComparisonProjectIds(rows), dependencies)
}

const markComparisonProjectsServingStaleForHumanSummaryJudgments = async (
  changes: readonly ComparisonProjectHumanSummaryJudgmentChange[],
  options: ComparisonProjectServingInvalidationOptions = {},
) => {
  const uniqueChanges = getUniqueEntries(changes, getHumanSummaryJudgmentChangeKey)
  const dependencies = getComparisonProjectServingInvalidationDependencies(options)

  if (uniqueChanges.length === 0) {
    return []
  }

  const rows = await dependencies.database.queryJson<ComparisonProjectIdRow>(
    getHumanSummaryJudgmentAffectedComparisonProjectIdsSql(uniqueChanges),
  )

  return markComparisonProjectsServingStaleForAffectedRows(getComparisonProjectIds(rows), dependencies)
}

const comparisonProjectServingInvalidationService = {
  getHumanPromptJudgmentAffectedComparisonProjectIdsSql,
  getHumanSummaryJudgmentAffectedComparisonProjectIdsSql,
  getLlmJudgmentAffectedComparisonProjectIdsSql,
  markComparisonProjectsServingStaleForHumanPromptJudgments,
  markComparisonProjectsServingStaleForHumanSummaryJudgments,
  markComparisonProjectsServingStaleForLlmJudgments,
}

export const getComparisonProjectServingInvalidationService = () => {
  return comparisonProjectServingInvalidationService
}
