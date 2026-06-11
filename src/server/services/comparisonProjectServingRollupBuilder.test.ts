import {rmSync} from 'node:fs'

import {expect, test} from 'bun:test'

import {
  type ComparisonProjectDifferenceColumn,
  type ComparisonProjectDifferenceFilter,
  getComparisonProjectHasAnyConflict,
  getComparisonProjectHasDifferenceFilterMatch,
} from '../../utils/comparisonProjectDifferenceFilter.ts'
import {
  type ComparisonProjectRowFilter,
  comparisonProjectRowFilters,
  getComparisonProjectPassesRowFilter,
} from '../../utils/comparisonProjectRowFilter.ts'
import {
  type ComparisonProjectScopedArticle,
  getComparisonProjectRequiredColumnIds,
} from '../routes/comparisonProjectsRoutes/comparisonProjectJudgmentRows.ts'
import {getComparisonProjectServingRollupBuilder} from './comparisonProjectServingRollupBuilder.ts'

type FixtureArticle = {
  articleCreatedAt: string
  articleExternalId: string
  articleSummary: string
  articleTitle: string
  id: string
}

type FixtureCell = {
  articleId: string
  columnId: string
  columnOrder: number
  contentKey: string | null
  displayAnswer: string
  kind: 'human' | 'llm'
  modelId: string | null
  normalizedAnswers: string[]
  projectId: string
  promptId: string
  sourceProjectId: string | null
}

type FixtureProject = {
  articles: FixtureArticle[]
  cells: FixtureCell[]
  columns: ComparisonProjectDifferenceColumn[]
  id: string
  isSummaryMode: boolean
}

type ActualArticleRollup = {
  answeredColumnCount: number
  answeredHumanColumnCount: number
  answeredLlmColumnCount: number
  answeredPromptCount: number
  articleId: string
  articleSummary: string | null
  articleTitle: string
  comparisonProjectId: string
  hasAllHumanColumns: boolean
  hasAllLlmColumns: boolean
  hasAnyDisagreement: boolean
  hasConflict: boolean
  hasHumanVsLlmDifference: boolean
  hasLlmVsLlmDifference: boolean
  hasMultipleAnswers: boolean
  isFullyAnswered: boolean
  requiredColumnCount: number
  requiredHumanColumnCount: number
  requiredLlmColumnCount: number
}

type ActualFilterMember = {
  articleId: string
  comparisonProjectId: string
  differenceFilter: ComparisonProjectDifferenceFilter
  ordinal: number
  rowFilter: ComparisonProjectRowFilter
}

type ActualFilterStats = {
  comparisonProjectId: string
  differenceFilter: ComparisonProjectDifferenceFilter
  rowFilter: ComparisonProjectRowFilter
  totalCount: number
}

type RollupBuilderResult = {
  articleRows: ActualArticleRollup[]
  memberRows: ActualFilterMember[]
  statsRows: ActualFilterStats[]
}

type TrueConflictArticleRollup = {
  articleId: string
  hasHumanVsLlmTrueConflict: boolean
  passesDifferenceFilterHumanVsLlmTrueConflict: boolean
}

type TrueConflictRollupResult = {
  articleRows: TrueConflictArticleRollup[]
  memberRows: Array<{articleId: string; ordinal: number}>
  statsRows: Array<{totalCount: number}>
}

type ScopedImportRollupRow = {
  articleExternalId: string | null
  canonicalOnly: string | null
  comparisonProjectId: string
  journalTitle: string | null
  sameValue: string | null
  scopedOnly: string | null
}

type ScopedImportRollupResult = {articleRows: ScopedImportRollupRow[]}

type ArticleCategory = 'chinese' | 'non_chinese'

type ArticleCategoryRollupResult = {articleRows: Array<{articleCategory: ArticleCategory; articleId: string}>}
type RequiredColumnStabilityResult = {
  actualRows: Array<{columnId: string; comparisonProjectId: string; kind: string; promptId: string}>
}

type TrueConflictCase = {
  articleCreatedAt: string
  articleId: string
  articleTitle: string
  hasTrueConflict: boolean
  humanAnswer: string
  llmAnswer: string
}

const contentKey = '1100'
const generation = 1
const promptProjectId = 'comparison-serving-rollup-prompt'
const summaryProjectId = 'comparison-serving-rollup-summary'
const trueConflictProjectId = 'comparison-serving-rollup-true-conflict'
const differenceFilters = [
  'all',
  'human-vs-llm-overlap',
  'human-vs-llm',
  'human-vs-llm-true-conflict',
  'llm-vs-llm',
  'any-disagreement',
] as const

const promptColumns = [
  {id: 'llm:model-a:1100:prompt-a', kind: 'llm', promptId: 'prompt-a'},
  {id: 'llm:model-b:1100:prompt-a', kind: 'llm', promptId: 'prompt-a'},
  {id: 'llm:model-a:1100:prompt-b', kind: 'llm', promptId: 'prompt-b'},
  {id: 'llm:model-b:1100:prompt-b', kind: 'llm', promptId: 'prompt-b'},
  {id: 'human:prompt-a', kind: 'human', promptId: 'prompt-a'},
  {id: 'human:prompt-b', kind: 'human', promptId: 'prompt-b'},
] satisfies ComparisonProjectDifferenceColumn[]

const summaryColumns = [
  {id: 'llm:source-project-a:model-a:1100:summary', kind: 'llm', promptId: 'summary'},
  {id: 'llm:source-project-b:model-b:1100:summary', kind: 'llm', promptId: 'summary'},
  {id: 'human:summary', kind: 'human', promptId: 'summary'},
] satisfies ComparisonProjectDifferenceColumn[]

const promptArticles = [
  {
    articleCreatedAt: '2026-04-04T00:00:00.000Z',
    articleExternalId: 'external-prompt-beta',
    articleSummary: 'Prompt beta summary',
    articleTitle: 'Beta Prompt Difference',
    id: 'article-prompt-beta-difference',
  },
  {
    articleCreatedAt: '2026-04-04T00:00:00.000Z',
    articleExternalId: 'external-prompt-alpha',
    articleSummary: 'Prompt alpha summary',
    articleTitle: 'Alpha Prompt No Difference',
    id: 'article-prompt-alpha-no-difference',
  },
  {
    articleCreatedAt: '2026-04-03T00:00:00.000Z',
    articleExternalId: 'external-prompt-llm',
    articleSummary: 'Prompt llm summary',
    articleTitle: 'Prompt LLM Difference',
    id: 'article-prompt-llm-difference',
  },
  {
    articleCreatedAt: '2026-04-02T00:00:00.000Z',
    articleExternalId: 'external-prompt-sparse',
    articleSummary: 'Prompt sparse summary',
    articleTitle: 'Prompt Sparse',
    id: 'article-prompt-sparse',
  },
] satisfies FixtureArticle[]

const summaryArticles = [
  {
    articleCreatedAt: '2026-05-04T00:00:00.000Z',
    articleExternalId: 'external-summary-conflict',
    articleSummary: 'Summary conflict summary',
    articleTitle: 'Summary Conflict',
    id: 'article-summary-conflict',
  },
  {
    articleCreatedAt: '2026-05-03T00:00:00.000Z',
    articleExternalId: 'external-summary-full',
    articleSummary: 'Summary full summary',
    articleTitle: 'Summary Full Agreement',
    id: 'article-summary-full-agreement',
  },
  {
    articleCreatedAt: '2026-05-02T00:00:00.000Z',
    articleExternalId: 'external-summary-sparse',
    articleSummary: 'Summary sparse summary',
    articleTitle: 'Summary Sparse',
    id: 'article-summary-sparse',
  },
  {
    articleCreatedAt: '2026-05-01T00:00:00.000Z',
    articleExternalId: 'external-summary-unjudged',
    articleSummary: 'Summary unjudged summary',
    articleTitle: 'Summary Unjudged',
    id: 'article-summary-unjudged',
  },
] satisfies FixtureArticle[]

const getPromptLlmCell = (params: {
  answer: string
  articleId: string
  modelId: 'model-a' | 'model-b'
  promptId: 'prompt-a' | 'prompt-b'
}) => {
  const promptOrder = params.promptId === 'prompt-a' ? 0 : 1
  const modelOrder = params.modelId === 'model-a' ? 0 : 1

  return {
    articleId: params.articleId,
    columnId: `llm:${params.modelId}:${contentKey}:${params.promptId}`,
    columnOrder: promptOrder * 2 + modelOrder,
    contentKey,
    displayAnswer: params.answer,
    kind: 'llm',
    modelId: params.modelId,
    normalizedAnswers: [params.answer.toLowerCase()],
    projectId: promptProjectId,
    promptId: params.promptId,
    sourceProjectId: null,
  } satisfies FixtureCell
}

const getPromptHumanCell = (params: {answer: string; articleId: string; promptId: 'prompt-a' | 'prompt-b'}) => {
  return {
    articleId: params.articleId,
    columnId: `human:${params.promptId}`,
    columnOrder: params.promptId === 'prompt-a' ? 4 : 5,
    contentKey: null,
    displayAnswer: params.answer,
    kind: 'human',
    modelId: null,
    normalizedAnswers: [params.answer.toLowerCase()],
    projectId: promptProjectId,
    promptId: params.promptId,
    sourceProjectId: null,
  } satisfies FixtureCell
}

const getSummaryLlmCell = (params: {
  answer: string
  articleId: string
  modelId: 'model-a' | 'model-b'
  sourceProjectId: 'source-project-a' | 'source-project-b'
}) => {
  const columnOrder = params.sourceProjectId === 'source-project-a' ? 0 : 1

  return {
    articleId: params.articleId,
    columnId: `llm:${params.sourceProjectId}:${params.modelId}:${contentKey}:summary`,
    columnOrder,
    contentKey,
    displayAnswer: params.answer,
    kind: 'llm',
    modelId: params.modelId,
    normalizedAnswers: [params.answer.toLowerCase()],
    projectId: summaryProjectId,
    promptId: 'summary',
    sourceProjectId: params.sourceProjectId,
  } satisfies FixtureCell
}

const getSummaryHumanCell = (params: {answer: string; articleId: string}) => {
  return {
    articleId: params.articleId,
    columnId: 'human:summary',
    columnOrder: 2,
    contentKey: null,
    displayAnswer: params.answer,
    kind: 'human',
    modelId: null,
    normalizedAnswers: [params.answer.toLowerCase()],
    projectId: summaryProjectId,
    promptId: 'summary',
    sourceProjectId: null,
  } satisfies FixtureCell
}

const promptCells = [
  getPromptLlmCell({
    answer: 'yes',
    articleId: 'article-prompt-beta-difference',
    modelId: 'model-a',
    promptId: 'prompt-a',
  }),
  getPromptLlmCell({
    answer: 'no',
    articleId: 'article-prompt-beta-difference',
    modelId: 'model-b',
    promptId: 'prompt-a',
  }),
  getPromptLlmCell({
    answer: 'yes',
    articleId: 'article-prompt-beta-difference',
    modelId: 'model-a',
    promptId: 'prompt-b',
  }),
  getPromptLlmCell({
    answer: 'yes',
    articleId: 'article-prompt-beta-difference',
    modelId: 'model-b',
    promptId: 'prompt-b',
  }),
  getPromptHumanCell({answer: 'maybe', articleId: 'article-prompt-beta-difference', promptId: 'prompt-a'}),
  getPromptHumanCell({answer: 'yes', articleId: 'article-prompt-beta-difference', promptId: 'prompt-b'}),
  getPromptLlmCell({
    answer: 'yes',
    articleId: 'article-prompt-alpha-no-difference',
    modelId: 'model-a',
    promptId: 'prompt-a',
  }),
  getPromptLlmCell({
    answer: 'yes',
    articleId: 'article-prompt-alpha-no-difference',
    modelId: 'model-b',
    promptId: 'prompt-a',
  }),
  getPromptLlmCell({
    answer: 'yes',
    articleId: 'article-prompt-alpha-no-difference',
    modelId: 'model-a',
    promptId: 'prompt-b',
  }),
  getPromptLlmCell({
    answer: 'yes',
    articleId: 'article-prompt-alpha-no-difference',
    modelId: 'model-b',
    promptId: 'prompt-b',
  }),
  getPromptHumanCell({answer: 'yes', articleId: 'article-prompt-alpha-no-difference', promptId: 'prompt-a'}),
  getPromptHumanCell({answer: 'yes', articleId: 'article-prompt-alpha-no-difference', promptId: 'prompt-b'}),
  getPromptLlmCell({
    answer: 'yes',
    articleId: 'article-prompt-llm-difference',
    modelId: 'model-a',
    promptId: 'prompt-a',
  }),
  getPromptLlmCell({
    answer: 'no',
    articleId: 'article-prompt-llm-difference',
    modelId: 'model-b',
    promptId: 'prompt-a',
  }),
  getPromptLlmCell({answer: 'yes', articleId: 'article-prompt-sparse', modelId: 'model-a', promptId: 'prompt-a'}),
] satisfies FixtureCell[]

const summaryCells = [
  getSummaryLlmCell({
    answer: 'yes',
    articleId: 'article-summary-conflict',
    modelId: 'model-a',
    sourceProjectId: 'source-project-a',
  }),
  getSummaryLlmCell({
    answer: 'no',
    articleId: 'article-summary-conflict',
    modelId: 'model-b',
    sourceProjectId: 'source-project-b',
  }),
  getSummaryHumanCell({answer: 'maybe', articleId: 'article-summary-conflict'}),
  getSummaryLlmCell({
    answer: 'yes',
    articleId: 'article-summary-full-agreement',
    modelId: 'model-a',
    sourceProjectId: 'source-project-a',
  }),
  getSummaryLlmCell({
    answer: 'yes',
    articleId: 'article-summary-full-agreement',
    modelId: 'model-b',
    sourceProjectId: 'source-project-b',
  }),
  getSummaryHumanCell({answer: 'yes', articleId: 'article-summary-full-agreement'}),
  getSummaryLlmCell({
    answer: 'yes',
    articleId: 'article-summary-sparse',
    modelId: 'model-a',
    sourceProjectId: 'source-project-a',
  }),
] satisfies FixtureCell[]

const fixtureProjects = [
  {articles: promptArticles, cells: promptCells, columns: promptColumns, id: promptProjectId, isSummaryMode: false},
  {articles: summaryArticles, cells: summaryCells, columns: summaryColumns, id: summaryProjectId, isSummaryMode: true},
] satisfies FixtureProject[]

const trueConflictCases = [
  {
    articleCreatedAt: '2026-07-05T00:00:00.000Z',
    articleId: 'article-yes-no',
    articleTitle: 'Yes vs No',
    hasTrueConflict: true,
    humanAnswer: 'yes',
    llmAnswer: 'no',
  },
  {
    articleCreatedAt: '2026-07-04T00:00:00.000Z',
    articleId: 'article-maybe-no',
    articleTitle: 'Maybe vs No',
    hasTrueConflict: true,
    humanAnswer: 'maybe',
    llmAnswer: 'no',
  },
  {
    articleCreatedAt: '2026-07-03T00:00:00.000Z',
    articleId: 'article-yes-maybe',
    articleTitle: 'Yes vs Maybe',
    hasTrueConflict: false,
    humanAnswer: 'yes',
    llmAnswer: 'maybe',
  },
  {
    articleCreatedAt: '2026-07-02T00:00:00.000Z',
    articleId: 'article-maybe-maybe',
    articleTitle: 'Maybe vs Maybe',
    hasTrueConflict: false,
    humanAnswer: 'maybe',
    llmAnswer: 'maybe',
  },
  {
    articleCreatedAt: '2026-07-01T00:00:00.000Z',
    articleId: 'article-no-no',
    articleTitle: 'No vs No',
    hasTrueConflict: false,
    humanAnswer: 'no',
    llmAnswer: 'no',
  },
] satisfies TrueConflictCase[]

const removeFileIfExists = (filePath: string) => {
  rmSync(filePath, {force: true, recursive: true})
}

const getLastJsonLine = (stdout: string) => {
  const lines = stdout
    .split('\n')
    .map((line) => {
      return line.trim()
    })
    .filter((line) => {
      return line !== ''
    })

  return lines.at(-1) ?? ''
}

const getSortedFixtureArticles = (articles: FixtureArticle[]): ComparisonProjectScopedArticle[] => {
  return [...articles]
    .sort((left, right) => {
      const dateComparison = new Date(right.articleCreatedAt).getTime() - new Date(left.articleCreatedAt).getTime()
      const titleComparison = left.articleTitle.localeCompare(right.articleTitle)

      return dateComparison !== 0
        ? dateComparison
        : titleComparison !== 0
          ? titleComparison
          : left.id.localeCompare(right.id)
    })
    .map((article) => {
      return {
        articleCreatedAt: new Date(article.articleCreatedAt),
        articleSummary: article.articleSummary,
        articleTitle: article.articleTitle,
        id: article.id,
      }
    })
}

const getFixtureCellsByArticle = (cells: FixtureCell[]) => {
  return cells.reduce<Record<string, Record<string, string | null>>>((articleMap, cell) => {
    const articleCells = articleMap[cell.articleId] ?? {}

    return {...articleMap, [cell.articleId]: {...articleCells, [cell.columnId]: cell.displayAnswer}}
  }, {})
}

const getExpectedArticleIds = (
  project: FixtureProject,
  rowFilter: ComparisonProjectRowFilter,
  differenceFilter: ComparisonProjectDifferenceFilter,
) => {
  const cellsByArticle = getFixtureCellsByArticle(project.cells)
  const expectedRollups = getExpectedArticleRollups(project)

  return getSortedFixtureArticles(project.articles)
    .filter((article) => {
      const articleCells = cellsByArticle[article.id] ?? {}
      const rollup = expectedRollups[article.id]

      return rollup
        ? getComparisonProjectPassesRowFilter({
            answeredColumnCount: rollup.answeredColumnCount,
            answeredPromptCount: rollup.answeredPromptCount,
            cells: articleCells,
            columns: project.columns,
            hasAllHumanColumns: rollup.hasAllHumanColumns,
            hasAllLlmColumns: rollup.hasAllLlmColumns,
            isSummaryMode: project.isSummaryMode,
            rowFilter,
          }) && getComparisonProjectHasDifferenceFilterMatch(articleCells, project.columns, differenceFilter)
        : false
    })
    .map((article) => {
      return article.id
    })
}

const getExpectedArticleRollups = (project: FixtureProject) => {
  const cellsByArticle = getFixtureCellsByArticle(project.cells)
  const llmColumnIds = getComparisonProjectRequiredColumnIds(project.columns, 'llm')
  const humanColumnIds = getComparisonProjectRequiredColumnIds(project.columns, 'human')
  const requiredColumnIds = new Set([...llmColumnIds, ...humanColumnIds])

  return project.articles.reduce<Record<string, Omit<ActualArticleRollup, 'comparisonProjectId'>>>(
    (rollupMap, article) => {
      const articleCells = cellsByArticle[article.id] ?? {}
      const answeredColumnIds = Array.from(requiredColumnIds).filter((columnId) => {
        return (articleCells[columnId]?.trim() ?? '') !== ''
      })
      const answeredPromptIds = new Set(
        project.columns
          .filter((column) => {
            return (articleCells[column.id]?.trim() ?? '') !== ''
          })
          .map((column) => {
            return column.promptId
          }),
      )
      const answeredLlmColumnCount = answeredColumnIds.filter((columnId) => {
        return llmColumnIds.has(columnId)
      }).length
      const answeredHumanColumnCount = answeredColumnIds.filter((columnId) => {
        return humanColumnIds.has(columnId)
      }).length
      const hasAllLlmColumns = answeredLlmColumnCount === llmColumnIds.size
      const hasAllHumanColumns = answeredHumanColumnCount === humanColumnIds.size
      const hasMultipleAnswers = project.isSummaryMode ? answeredColumnIds.length >= 2 : answeredPromptIds.size >= 2

      return {
        ...rollupMap,
        [article.id]: {
          answeredColumnCount: answeredColumnIds.length,
          answeredHumanColumnCount,
          answeredLlmColumnCount,
          answeredPromptCount: answeredPromptIds.size,
          articleId: article.id,
          articleSummary: article.articleSummary,
          articleTitle: article.articleTitle,
          hasAllHumanColumns,
          hasAllLlmColumns,
          hasAnyDisagreement: getComparisonProjectHasDifferenceFilterMatch(
            articleCells,
            project.columns,
            'any-disagreement',
          ),
          hasConflict: getComparisonProjectHasAnyConflict(articleCells, project.columns),
          hasHumanVsLlmDifference: getComparisonProjectHasDifferenceFilterMatch(
            articleCells,
            project.columns,
            'human-vs-llm',
          ),
          hasLlmVsLlmDifference: getComparisonProjectHasDifferenceFilterMatch(
            articleCells,
            project.columns,
            'llm-vs-llm',
          ),
          hasMultipleAnswers,
          isFullyAnswered: hasAllLlmColumns && hasAllHumanColumns,
          requiredColumnCount: requiredColumnIds.size,
          requiredHumanColumnCount: humanColumnIds.size,
          requiredLlmColumnCount: llmColumnIds.size,
        },
      }
    },
    {},
  )
}

const getRollupScript = () => {
  return `
    const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
    const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
    const {getSqlLiteral} = await import('./src/server/services/appQueryHelpers.ts')
    const {getComparisonProjectServingRollupBuilder} = await import('./src/server/services/comparisonProjectServingRollupBuilder.ts')

    const fixtureProjects = ${JSON.stringify(fixtureProjects)}
    const generation = ${generation}

    await migrateDuckdb()

    const database = getAppDatabaseService()
    const builder = getComparisonProjectServingRollupBuilder()
    const getValuesSql = (columns, rows) => {
      return rows.map((row) => {
        return '(' + columns.map((column) => getSqlLiteral(row[column])).join(', ') + ')'
      }).join(',\\n')
    }
    const insertRows = async (tableName, columns, rows) => {
      if (rows.length === 0) {
        return
      }

      await database.run(\`
        INSERT INTO \${tableName} (\${columns.join(', ')})
        VALUES \${getValuesSql(columns, rows)}
      \`)
    }

    await database.run(\`
      INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
      VALUES ('provider-rollup', 'sglang', 'Provider Rollup', TRUE, 'none', 'http://localhost:30001/v1')
    \`)

    await database.run(\`
      INSERT INTO app.model (
        id,
        provider_connection_id,
        name,
        remote_model_id,
        display_name,
        variant,
        source,
        enabled,
        metadata_json
      ) VALUES
        ('model-a', 'provider-rollup', 'Model A', 'model-a', 'Model A', 'manual', 'manual', TRUE, '{}'::JSON),
        ('model-b', 'provider-rollup', 'Model B', 'model-b', 'Model B', 'manual', 'manual', TRUE, '{}'::JSON)
    \`)

    await insertRows('app.prompt', ['id', 'original_text', 'prompt_heading', 'content_hash', 'created_at'], [
      {id: 'prompt-a', original_text: 'Prompt A', prompt_heading: 'Prompt A', content_hash: 'prompt-a-hash', created_at: '2026-01-01T00:00:00.000Z'},
      {id: 'prompt-b', original_text: 'Prompt B', prompt_heading: 'Prompt B', content_hash: 'prompt-b-hash', created_at: '2026-01-02T00:00:00.000Z'},
      {id: 'summary-source-a-include', original_text: 'Summary A Include', prompt_heading: 'Summary A Include', content_hash: 'summary-a-include-hash', created_at: '2026-01-03T00:00:00.000Z'},
      {id: 'summary-source-b-include', original_text: 'Summary B Include', prompt_heading: 'Summary B Include', content_hash: 'summary-b-include-hash', created_at: '2026-01-04T00:00:00.000Z'}
    ])

    await insertRows('app.article', ['id', 'article_id', 'article_title', 'article_summary', 'article_created_at', 'article_updated_at'], fixtureProjects.flatMap((project) => {
      return project.articles.map((article) => {
        return {
          id: article.id,
          article_id: article.articleExternalId,
          article_title: article.articleTitle,
          article_summary: article.articleSummary,
          article_created_at: article.articleCreatedAt,
          article_updated_at: article.articleCreatedAt
        }
      })
    }))

    await insertRows('app.project', ['id', 'name', 'description', 'model_id', 'human_judgment_mode', 'use_title', 'use_abstract', 'use_fulltext', 'use_fulltext_no_images'], [
      {id: 'source-project-a', name: 'Source Project A', description: null, model_id: 'model-a', human_judgment_mode: 'summary', use_title: true, use_abstract: true, use_fulltext: false, use_fulltext_no_images: false},
      {id: 'source-project-b', name: 'Source Project B', description: null, model_id: 'model-b', human_judgment_mode: 'summary', use_title: true, use_abstract: true, use_fulltext: false, use_fulltext_no_images: false}
    ])

    await insertRows('app.project_prompt', ['id', 'project_id', 'prompt_id', 'prompt_order', 'enabled', 'criteria_disposition', 'criteria_section_key', 'criteria_section_label'], [
      {id: 'source-project-a-include', project_id: 'source-project-a', prompt_id: 'summary-source-a-include', prompt_order: 0, enabled: true, criteria_disposition: 'include', criteria_section_key: 'population', criteria_section_label: 'Population'},
      {id: 'source-project-b-include', project_id: 'source-project-b', prompt_id: 'summary-source-b-include', prompt_order: 0, enabled: true, criteria_disposition: 'include', criteria_section_key: 'population', criteria_section_label: 'Population'}
    ])

    await insertRows('app.project_article', ['id', 'project_id', 'article_id'], [
      {id: 'source-project-a-summary-conflict', project_id: 'source-project-a', article_id: 'article-summary-conflict'},
      {id: 'source-project-a-summary-full', project_id: 'source-project-a', article_id: 'article-summary-full-agreement'},
      {id: 'source-project-a-summary-sparse', project_id: 'source-project-a', article_id: 'article-summary-sparse'},
      {id: 'source-project-a-summary-unjudged', project_id: 'source-project-a', article_id: 'article-summary-unjudged'},
      {id: 'source-project-b-summary-conflict', project_id: 'source-project-b', article_id: 'article-summary-conflict'},
      {id: 'source-project-b-summary-full', project_id: 'source-project-b', article_id: 'article-summary-full-agreement'},
      {id: 'source-project-b-summary-sparse', project_id: 'source-project-b', article_id: 'article-summary-sparse'},
      {id: 'source-project-b-summary-unjudged', project_id: 'source-project-b', article_id: 'article-summary-unjudged'}
    ])

    await insertRows('app.comparison_project', ['id', 'name', 'description', 'model_ids', 'compare_with_humans', 'human_judgment_mode', 'summary_source_project_id', 'use_title', 'use_abstract', 'use_fulltext', 'use_fulltext_no_images'], [
      {id: '${promptProjectId}', name: 'Prompt Rollup Project', description: null, model_ids: ['model-a', 'model-b'], compare_with_humans: true, human_judgment_mode: 'prompt', summary_source_project_id: null, use_title: true, use_abstract: true, use_fulltext: false, use_fulltext_no_images: false},
      {id: '${summaryProjectId}', name: 'Summary Rollup Project', description: null, model_ids: ['model-a', 'model-b'], compare_with_humans: true, human_judgment_mode: 'summary', summary_source_project_id: 'source-project-a', use_title: true, use_abstract: true, use_fulltext: false, use_fulltext_no_images: false}
    ])

    await insertRows('app.comparison_project_prompt', ['id', 'comparison_project_id', 'prompt_id', 'prompt_order', 'criteria_disposition', 'criteria_section_key', 'criteria_section_label'], [
      {id: 'comparison-prompt-a', comparison_project_id: '${promptProjectId}', prompt_id: 'prompt-a', prompt_order: 0, criteria_disposition: null, criteria_section_key: null, criteria_section_label: null},
      {id: 'comparison-prompt-b', comparison_project_id: '${promptProjectId}', prompt_id: 'prompt-b', prompt_order: 1, criteria_disposition: null, criteria_section_key: null, criteria_section_label: null},
      {id: 'comparison-summary-a', comparison_project_id: '${summaryProjectId}', prompt_id: 'summary-source-a-include', prompt_order: 0, criteria_disposition: 'include', criteria_section_key: 'population', criteria_section_label: 'Population'},
      {id: 'comparison-summary-b', comparison_project_id: '${summaryProjectId}', prompt_id: 'summary-source-b-include', prompt_order: 1, criteria_disposition: 'include', criteria_section_key: 'population', criteria_section_label: 'Population'}
    ])

    await insertRows('app.comparison_project_source_project', ['id', 'comparison_project_id', 'source_project_id', 'created_at'], [
      {id: 'comparison-summary-source-a', comparison_project_id: '${summaryProjectId}', source_project_id: 'source-project-a', created_at: '2026-01-01T00:00:00.000Z'},
      {id: 'comparison-summary-source-b', comparison_project_id: '${summaryProjectId}', source_project_id: 'source-project-b', created_at: '2026-01-02T00:00:00.000Z'}
    ])

    await insertRows('mart.comparison_cell_serving', ['comparison_project_id', 'generation', 'article_id', 'column_id', 'column_order', 'kind', 'prompt_id', 'model_id', 'source_project_id', 'content_key', 'display_answer', 'normalized_answers', 'source_created_at', 'source_updated_at'], fixtureProjects.flatMap((project) => {
      return project.cells.map((cell) => {
        return {
          comparison_project_id: cell.projectId,
          generation,
          article_id: cell.articleId,
          column_id: cell.columnId,
          column_order: cell.columnOrder,
          kind: cell.kind,
          prompt_id: cell.promptId,
          model_id: cell.modelId,
          source_project_id: cell.sourceProjectId,
          content_key: cell.contentKey,
          display_answer: cell.displayAnswer,
          normalized_answers: cell.normalizedAnswers,
          source_created_at: '2026-06-01T00:00:00.000Z',
          source_updated_at: '2026-06-01T01:00:00.000Z'
        }
      })
    }))

    for (const project of fixtureProjects) {
      await builder.insertComparisonProjectServingRollups(
        {comparisonProjectId: project.id, generation},
        {queryJson: database.queryJson, run: database.run}
      )
    }

    const articleRows = await database.queryJson(\`
      SELECT
        comparison_project_id AS comparisonProjectId,
        article_id AS articleId,
        article_title AS articleTitle,
        article_summary AS articleSummary,
        CAST(answered_prompt_count AS INTEGER) AS answeredPromptCount,
        CAST(answered_column_count AS INTEGER) AS answeredColumnCount,
        CAST(answered_llm_column_count AS INTEGER) AS answeredLlmColumnCount,
        CAST(answered_human_column_count AS INTEGER) AS answeredHumanColumnCount,
        CAST(required_column_count AS INTEGER) AS requiredColumnCount,
        CAST(required_llm_column_count AS INTEGER) AS requiredLlmColumnCount,
        CAST(required_human_column_count AS INTEGER) AS requiredHumanColumnCount,
        has_all_llm_columns AS hasAllLlmColumns,
        has_all_human_columns AS hasAllHumanColumns,
        has_multiple_answers AS hasMultipleAnswers,
        is_fully_answered AS isFullyAnswered,
        has_human_vs_llm_difference AS hasHumanVsLlmDifference,
        has_llm_vs_llm_difference AS hasLlmVsLlmDifference,
        has_any_disagreement AS hasAnyDisagreement,
        has_conflict AS hasConflict
      FROM mart.comparison_article_serving
      ORDER BY comparison_project_id ASC, article_id ASC
    \`)

    const memberRows = await database.queryJson(\`
      SELECT
        comparison_project_id AS comparisonProjectId,
        row_filter AS rowFilter,
        difference_filter AS differenceFilter,
        article_id AS articleId,
        CAST(ordinal AS INTEGER) AS ordinal
      FROM mart.comparison_filter_member
      ORDER BY comparison_project_id ASC, row_filter ASC, difference_filter ASC, ordinal ASC
    \`)

    const statsRows = await database.queryJson(\`
      SELECT
        comparison_project_id AS comparisonProjectId,
        row_filter AS rowFilter,
        difference_filter AS differenceFilter,
        CAST(total_count AS INTEGER) AS totalCount
      FROM mart.comparison_filter_stats
      ORDER BY comparison_project_id ASC, row_filter ASC, difference_filter ASC
    \`)

    console.log(JSON.stringify({articleRows, memberRows, statsRows}))
  `
}

const getTrueConflictRollupScript = () => {
  return `
    const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
    const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
    const {getSqlLiteral} = await import('./src/server/services/appQueryHelpers.ts')
    const {getComparisonProjectServingRollupBuilder} = await import('./src/server/services/comparisonProjectServingRollupBuilder.ts')

    const trueConflictCases = ${JSON.stringify(trueConflictCases)}
    const generation = ${generation}
    const projectId = '${trueConflictProjectId}'

    await migrateDuckdb()

    const database = getAppDatabaseService()
    const builder = getComparisonProjectServingRollupBuilder()
    const getValuesSql = (columns, rows) => {
      return rows.map((row) => {
        return '(' + columns.map((column) => getSqlLiteral(row[column])).join(', ') + ')'
      }).join(',\\n')
    }
    const insertRows = async (tableName, columns, rows) => {
      if (rows.length === 0) {
        return
      }

      await database.run(\`
        INSERT INTO \${tableName} (\${columns.join(', ')})
        VALUES \${getValuesSql(columns, rows)}
      \`)
    }

    await database.run(\`
      INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
      VALUES ('provider-true-conflict', 'sglang', 'Provider True Conflict', TRUE, 'none', 'http://localhost:30001/v1')
    \`)

    await database.run(\`
      INSERT INTO app.model (
        id,
        provider_connection_id,
        name,
        remote_model_id,
        display_name,
        variant,
        source,
        enabled,
        metadata_json
      ) VALUES ('model-true-conflict', 'provider-true-conflict', 'Model True Conflict', 'model-true-conflict', 'Model True Conflict', 'manual', 'manual', TRUE, '{}'::JSON)
    \`)

    await insertRows('app.prompt', ['id', 'original_text', 'prompt_heading', 'content_hash', 'created_at'], [
      {id: 'prompt-true-conflict', original_text: 'Prompt True Conflict', prompt_heading: 'Prompt True Conflict', content_hash: 'prompt-true-conflict-hash', created_at: '2026-07-01T00:00:00.000Z'}
    ])

    await insertRows('app.article', ['id', 'article_id', 'article_title', 'article_summary', 'article_created_at', 'article_updated_at'], trueConflictCases.map((testCase) => {
      return {
        id: testCase.articleId,
        article_id: testCase.articleId,
        article_title: testCase.articleTitle,
        article_summary: testCase.articleTitle + ' summary',
        article_created_at: testCase.articleCreatedAt,
        article_updated_at: testCase.articleCreatedAt
      }
    }))

    await insertRows('app.comparison_project', ['id', 'name', 'description', 'model_ids', 'compare_with_humans', 'human_judgment_mode', 'summary_source_project_id', 'use_title', 'use_abstract', 'use_fulltext', 'use_fulltext_no_images'], [
      {id: projectId, name: 'True Conflict Rollup Project', description: null, model_ids: ['model-true-conflict'], compare_with_humans: true, human_judgment_mode: 'prompt', summary_source_project_id: null, use_title: true, use_abstract: true, use_fulltext: false, use_fulltext_no_images: false}
    ])

    await insertRows('app.comparison_project_prompt', ['id', 'comparison_project_id', 'prompt_id', 'prompt_order', 'criteria_disposition', 'criteria_section_key', 'criteria_section_label'], [
      {id: 'comparison-true-conflict-prompt', comparison_project_id: projectId, prompt_id: 'prompt-true-conflict', prompt_order: 0, criteria_disposition: null, criteria_section_key: null, criteria_section_label: null}
    ])

    await insertRows('mart.comparison_cell_serving', ['comparison_project_id', 'generation', 'article_id', 'column_id', 'column_order', 'kind', 'prompt_id', 'model_id', 'source_project_id', 'content_key', 'display_answer', 'normalized_answers', 'source_created_at', 'source_updated_at'], trueConflictCases.flatMap((testCase) => {
      return [
        {
          comparison_project_id: projectId,
          generation,
          article_id: testCase.articleId,
          column_id: 'llm:model-true-conflict:1100:prompt-true-conflict',
          column_order: 0,
          kind: 'llm',
          prompt_id: 'prompt-true-conflict',
          model_id: 'model-true-conflict',
          source_project_id: null,
          content_key: '1100',
          display_answer: testCase.llmAnswer,
          normalized_answers: [testCase.llmAnswer],
          source_created_at: '2026-07-01T01:00:00.000Z',
          source_updated_at: '2026-07-01T02:00:00.000Z'
        },
        {
          comparison_project_id: projectId,
          generation,
          article_id: testCase.articleId,
          column_id: 'human:prompt-true-conflict',
          column_order: 1,
          kind: 'human',
          prompt_id: 'prompt-true-conflict',
          model_id: null,
          source_project_id: null,
          content_key: null,
          display_answer: testCase.humanAnswer,
          normalized_answers: [testCase.humanAnswer],
          source_created_at: '2026-07-01T01:00:00.000Z',
          source_updated_at: '2026-07-01T02:00:00.000Z'
        }
      ]
    }))

    await builder.insertComparisonProjectServingRollups(
      {comparisonProjectId: projectId, generation},
      {queryJson: database.queryJson, run: database.run}
    )

    const articleRows = await database.queryJson(\`
      SELECT
        article_id AS articleId,
        has_human_vs_llm_true_conflict AS hasHumanVsLlmTrueConflict,
        passes_difference_filter_human_vs_llm_true_conflict AS passesDifferenceFilterHumanVsLlmTrueConflict
      FROM mart.comparison_article_serving
      WHERE comparison_project_id = '\${projectId}'
      ORDER BY article_id ASC
    \`)

    const memberRows = await database.queryJson(\`
      SELECT
        article_id AS articleId,
        CAST(ordinal AS INTEGER) AS ordinal
      FROM mart.comparison_filter_member
      WHERE comparison_project_id = '\${projectId}'
        AND row_filter = 'all'
        AND difference_filter = 'human-vs-llm-true-conflict'
      ORDER BY ordinal ASC
    \`)

    const statsRows = await database.queryJson(\`
      SELECT CAST(total_count AS INTEGER) AS totalCount
      FROM mart.comparison_filter_stats
      WHERE comparison_project_id = '\${projectId}'
        AND row_filter = 'all'
        AND difference_filter = 'human-vs-llm-true-conflict'
    \`)

    console.log(JSON.stringify({articleRows, memberRows, statsRows}))
  `
}

const getScopedImportRollupScript = () => {
  return `
    const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
    const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
    const {getSqlLiteral} = await import('./src/server/services/appQueryHelpers.ts')
    const {getComparisonProjectServingRollupBuilder} = await import('./src/server/services/comparisonProjectServingRollupBuilder.ts')

    await migrateDuckdb()

    const database = getAppDatabaseService()
    const builder = getComparisonProjectServingRollupBuilder()
    const generation = ${generation}
    const getValuesSql = (columns, rows) => {
      return rows.map((row) => {
        return '(' + columns.map((column) => getSqlLiteral(row[column])).join(', ') + ')'
      }).join(',\\n')
    }
    const insertRows = async (tableName, columns, rows) => {
      if (rows.length === 0) {
        return
      }

      await database.run(\`
        INSERT INTO \${tableName} (\${columns.join(', ')})
        VALUES \${getValuesSql(columns, rows)}
      \`)
    }

    await database.run(\`
      INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
      VALUES ('provider-scoped-import', 'sglang', 'Provider Scoped Import', TRUE, 'none', 'http://localhost:30001/v1')
    \`)

    await database.run(\`
      INSERT INTO app.model (
        id,
        provider_connection_id,
        name,
        remote_model_id,
        display_name,
        variant,
        source,
        enabled,
        metadata_json
      ) VALUES ('model-scoped-import', 'provider-scoped-import', 'Model Scoped Import', 'model-scoped-import', 'Model Scoped Import', 'manual', 'manual', TRUE, '{}'::JSON)
    \`)

    await insertRows('app.prompt', ['id', 'original_text', 'prompt_heading', 'content_hash', 'created_at'], [
      {id: 'prompt-scoped-import', original_text: 'Prompt Scoped Import', prompt_heading: 'Prompt Scoped Import', content_hash: 'prompt-scoped-import-hash', created_at: '2026-08-01T00:00:00.000Z'}
    ])

    await database.run(\`
      INSERT INTO app.article (
        id,
        article_id,
        article_title,
        article_summary,
        article_created_at,
        article_updated_at,
        source_metadata
      ) VALUES (
        'canonical-scoped-import-article',
        'legacy-article-id',
        'Scoped Import Article',
        'Scoped Import Summary',
        TIMESTAMPTZ '2026-08-01T00:00:00.000Z',
        TIMESTAMPTZ '2026-08-01T01:00:00.000Z',
        CAST('{"canonicalOnly":"canonical","same":"canonical","journalTitle":"Canonical Journal"}' AS JSON)
      )
    \`)

    await insertRows('app.project', ['id', 'name', 'description', 'model_id', 'human_judgment_mode', 'use_title', 'use_abstract', 'use_fulltext', 'use_fulltext_no_images'], [
      {id: 'source-project-a', name: 'Source Project A', description: null, model_id: 'model-scoped-import', human_judgment_mode: 'prompt', use_title: true, use_abstract: true, use_fulltext: false, use_fulltext_no_images: false},
      {id: 'source-project-b', name: 'Source Project B', description: null, model_id: 'model-scoped-import', human_judgment_mode: 'prompt', use_title: true, use_abstract: true, use_fulltext: false, use_fulltext_no_images: false}
    ])

    await insertRows('app.import_route', ['id', 'route', 'name', 'description'], [
      {id: 'route-a', route: 'route-a', name: 'Route A', description: null},
      {id: 'route-b', route: 'route-b', name: 'Route B', description: null},
      {id: 'route-z', route: 'route-z', name: 'Route Z', description: null}
    ])

    await insertRows('app.project_import_route', ['id', 'project_id', 'import_route_id'], [
      {id: 'project-route-a', project_id: 'source-project-a', import_route_id: 'route-a'},
      {id: 'project-route-b', project_id: 'source-project-b', import_route_id: 'route-b'}
    ])

    await database.run(\`
      INSERT INTO app.article_import_route (
        id,
        article_id,
        import_route_id,
        external_article_id,
        source_kind,
        import_metadata,
        source_record_key,
        source_record_hash,
        raw_payload
      ) VALUES
        (
          'air-route-b',
          'canonical-scoped-import-article',
          'route-b',
          'external-route-b',
          'test',
          CAST('{"scopedOnly":"route-b","same":"route-b","journalTitle":"Route B Journal"}' AS JSON),
          'source-b-record',
          'source-b-hash',
          CAST('{}' AS JSON)
        ),
        (
          'air-route-a',
          'canonical-scoped-import-article',
          'route-a',
          'external-route-a',
          'test',
          CAST('{"scopedOnly":"route-a","same":"route-a","journalTitle":"Route A Journal"}' AS JSON),
          'source-a-record',
          'source-a-hash',
          CAST('{}' AS JSON)
        ),
        (
          'air-route-z',
          'canonical-scoped-import-article',
          'route-z',
          'external-route-z',
          'test',
          CAST('{"scopedOnly":"route-z","same":"route-z","journalTitle":"Route Z Journal"}' AS JSON),
          'source-z-record',
          'source-z-hash',
          CAST('{}' AS JSON)
        )
    \`)

    await insertRows('app.project_article', ['id', 'project_id', 'article_id'], [
      {id: 'project-article-a', project_id: 'source-project-a', article_id: 'canonical-scoped-import-article'},
      {id: 'project-article-b', project_id: 'source-project-b', article_id: 'canonical-scoped-import-article'}
    ])

    await insertRows('app.comparison_project', ['id', 'name', 'description', 'model_ids', 'compare_with_humans', 'human_judgment_mode', 'summary_source_project_id', 'use_title', 'use_abstract', 'use_fulltext', 'use_fulltext_no_images'], [
      {id: 'comparison-no-scope', name: 'Comparison No Scope', description: null, model_ids: ['model-scoped-import'], compare_with_humans: false, human_judgment_mode: 'prompt', summary_source_project_id: null, use_title: true, use_abstract: true, use_fulltext: false, use_fulltext_no_images: false},
      {id: 'comparison-source-scope', name: 'Comparison Source Scope', description: null, model_ids: ['model-scoped-import'], compare_with_humans: false, human_judgment_mode: 'prompt', summary_source_project_id: null, use_title: true, use_abstract: true, use_fulltext: false, use_fulltext_no_images: false},
      {id: 'comparison-route-scope', name: 'Comparison Route Scope', description: null, model_ids: ['model-scoped-import'], compare_with_humans: false, human_judgment_mode: 'prompt', summary_source_project_id: null, use_title: true, use_abstract: true, use_fulltext: false, use_fulltext_no_images: false}
    ])

    await insertRows('app.comparison_project_prompt', ['id', 'comparison_project_id', 'prompt_id', 'prompt_order', 'criteria_disposition', 'criteria_section_key', 'criteria_section_label'], [
      {id: 'comparison-no-scope-prompt', comparison_project_id: 'comparison-no-scope', prompt_id: 'prompt-scoped-import', prompt_order: 0, criteria_disposition: null, criteria_section_key: null, criteria_section_label: null},
      {id: 'comparison-source-prompt', comparison_project_id: 'comparison-source-scope', prompt_id: 'prompt-scoped-import', prompt_order: 0, criteria_disposition: null, criteria_section_key: null, criteria_section_label: null},
      {id: 'comparison-route-prompt', comparison_project_id: 'comparison-route-scope', prompt_id: 'prompt-scoped-import', prompt_order: 0, criteria_disposition: null, criteria_section_key: null, criteria_section_label: null}
    ])

    await insertRows('app.comparison_project_source_project', ['id', 'comparison_project_id', 'source_project_id', 'created_at'], [
      {id: 'comparison-source-link-b', comparison_project_id: 'comparison-source-scope', source_project_id: 'source-project-b', created_at: '2026-08-01T00:00:00.000Z'},
      {id: 'comparison-source-link-a', comparison_project_id: 'comparison-source-scope', source_project_id: 'source-project-a', created_at: '2026-08-02T00:00:00.000Z'}
    ])

    await insertRows('app.comparison_project_import_route', ['id', 'comparison_project_id', 'import_route_id'], [
      {id: 'comparison-source-route-z', comparison_project_id: 'comparison-source-scope', import_route_id: 'route-z'},
      {id: 'comparison-route-route-z', comparison_project_id: 'comparison-route-scope', import_route_id: 'route-z'},
      {id: 'comparison-route-route-a', comparison_project_id: 'comparison-route-scope', import_route_id: 'route-a'}
    ])

    await insertRows('mart.comparison_cell_serving', ['comparison_project_id', 'generation', 'article_id', 'column_id', 'column_order', 'kind', 'prompt_id', 'model_id', 'source_project_id', 'content_key', 'display_answer', 'normalized_answers', 'source_created_at', 'source_updated_at'], [
      {comparison_project_id: 'comparison-no-scope', generation, article_id: 'canonical-scoped-import-article', column_id: 'llm:model-scoped-import:1100:prompt-scoped-import', column_order: 0, kind: 'llm', prompt_id: 'prompt-scoped-import', model_id: 'model-scoped-import', source_project_id: null, content_key: '1100', display_answer: 'yes', normalized_answers: ['yes'], source_created_at: '2026-08-01T02:00:00.000Z', source_updated_at: '2026-08-01T03:00:00.000Z'},
      {comparison_project_id: 'comparison-source-scope', generation, article_id: 'canonical-scoped-import-article', column_id: 'llm:model-scoped-import:1100:prompt-scoped-import', column_order: 0, kind: 'llm', prompt_id: 'prompt-scoped-import', model_id: 'model-scoped-import', source_project_id: null, content_key: '1100', display_answer: 'yes', normalized_answers: ['yes'], source_created_at: '2026-08-01T02:00:00.000Z', source_updated_at: '2026-08-01T03:00:00.000Z'},
      {comparison_project_id: 'comparison-route-scope', generation, article_id: 'canonical-scoped-import-article', column_id: 'llm:model-scoped-import:1100:prompt-scoped-import', column_order: 0, kind: 'llm', prompt_id: 'prompt-scoped-import', model_id: 'model-scoped-import', source_project_id: null, content_key: '1100', display_answer: 'yes', normalized_answers: ['yes'], source_created_at: '2026-08-01T02:00:00.000Z', source_updated_at: '2026-08-01T03:00:00.000Z'}
    ])

    await builder.insertComparisonProjectServingRollups(
      {comparisonProjectId: 'comparison-no-scope', generation},
      {queryJson: database.queryJson, run: database.run}
    )
    await builder.insertComparisonProjectServingRollups(
      {comparisonProjectId: 'comparison-source-scope', generation},
      {queryJson: database.queryJson, run: database.run}
    )
    await builder.insertComparisonProjectServingRollups(
      {comparisonProjectId: 'comparison-route-scope', generation},
      {queryJson: database.queryJson, run: database.run}
    )

    const articleRows = await database.queryJson(\`
      SELECT
        comparison_project_id AS comparisonProjectId,
        article_external_id AS articleExternalId,
        journal_title AS journalTitle,
        json_extract_string(source_metadata, '$.canonicalOnly') AS canonicalOnly,
        json_extract_string(source_metadata, '$.scopedOnly') AS scopedOnly,
        json_extract_string(source_metadata, '$.same') AS sameValue
      FROM mart.comparison_article_serving
      WHERE comparison_project_id IN ('comparison-no-scope', 'comparison-source-scope', 'comparison-route-scope')
      ORDER BY comparison_project_id ASC
    \`)

    console.log(JSON.stringify({articleRows}))
  `
}

const getArticleCategoryRollupScript = () => {
  return `
    const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
    const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
    const {getSqlLiteral} = await import('./src/server/services/appQueryHelpers.ts')
    const {getComparisonProjectServingRollupBuilder} = await import('./src/server/services/comparisonProjectServingRollupBuilder.ts')

    await migrateDuckdb()

    const database = getAppDatabaseService()
    const builder = getComparisonProjectServingRollupBuilder()
    const generation = ${generation}
    const projectId = 'comparison-category'
    const getValuesSql = (columns, rows) => {
      return rows.map((row) => {
        return '(' + columns.map((column) => getSqlLiteral(row[column])).join(', ') + ')'
      }).join(',\\n')
    }
    const insertRows = async (tableName, columns, rows) => {
      if (rows.length === 0) {
        return
      }

      await database.run(\`
        INSERT INTO \${tableName} (\${columns.join(', ')})
        VALUES \${getValuesSql(columns, rows)}
      \`)
    }

    await database.run(\`
      INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
      VALUES ('provider-category', 'sglang', 'Provider Category', TRUE, 'none', 'http://localhost:30001/v1')
    \`)

    await database.run(\`
      INSERT INTO app.model (
        id,
        provider_connection_id,
        name,
        remote_model_id,
        display_name,
        variant,
        source,
        enabled,
        metadata_json
      ) VALUES ('model-category', 'provider-category', 'Model Category', 'model-category', 'Model Category', 'manual', 'manual', TRUE, '{}'::JSON)
    \`)

    await insertRows('app.prompt', ['id', 'original_text', 'prompt_heading', 'content_hash', 'created_at'], [
      {id: 'prompt-category', original_text: 'Prompt Category', prompt_heading: 'Prompt Category', content_hash: 'prompt-category-hash', created_at: '2026-09-01T00:00:00.000Z'}
    ])

    await database.run(\`
      INSERT INTO app.article (
        id,
        article_id,
        article_title,
        article_summary,
        article_created_at,
        article_updated_at,
        source_metadata
      ) VALUES
        (
          'category-metadata-language',
          'category-metadata-language',
          'Metadata Language Article',
          'Metadata language summary',
          TIMESTAMPTZ '2026-09-01T00:00:00.000Z',
          TIMESTAMPTZ '2026-09-01T01:00:00.000Z',
          CAST('{"language":"zh-CN"}' AS JSON)
        ),
        (
          'category-cjk-title',
          'category-cjk-title',
          'Han Script \u7814\u7a76 Title',
          'Plain abstract',
          TIMESTAMPTZ '2026-09-02T00:00:00.000Z',
          TIMESTAMPTZ '2026-09-02T01:00:00.000Z',
          NULL
        ),
        (
          'category-cjk-abstract',
          'category-cjk-abstract',
          'Plain title',
          'Abstract with Han \u6458\u8981 text',
          TIMESTAMPTZ '2026-09-03T00:00:00.000Z',
          TIMESTAMPTZ '2026-09-03T01:00:00.000Z',
          NULL
        ),
        (
          'category-non-chinese',
          'category-non-chinese',
          'Plain English Title',
          'Plain English abstract',
          TIMESTAMPTZ '2026-09-04T00:00:00.000Z',
          TIMESTAMPTZ '2026-09-04T01:00:00.000Z',
          CAST('{"language":"en"}' AS JSON)
        )
    \`)

    await insertRows('app.comparison_project', ['id', 'name', 'description', 'model_ids', 'compare_with_humans', 'human_judgment_mode', 'summary_source_project_id', 'use_title', 'use_abstract', 'use_fulltext', 'use_fulltext_no_images'], [
      {id: projectId, name: 'Article Category Project', description: null, model_ids: ['model-category'], compare_with_humans: false, human_judgment_mode: 'prompt', summary_source_project_id: null, use_title: true, use_abstract: true, use_fulltext: false, use_fulltext_no_images: false}
    ])

    await insertRows('app.comparison_project_prompt', ['id', 'comparison_project_id', 'prompt_id', 'prompt_order', 'criteria_disposition', 'criteria_section_key', 'criteria_section_label'], [
      {id: 'comparison-category-prompt', comparison_project_id: projectId, prompt_id: 'prompt-category', prompt_order: 0, criteria_disposition: null, criteria_section_key: null, criteria_section_label: null}
    ])

    await insertRows('mart.comparison_cell_serving', ['comparison_project_id', 'generation', 'article_id', 'column_id', 'column_order', 'kind', 'prompt_id', 'model_id', 'source_project_id', 'content_key', 'display_answer', 'normalized_answers', 'source_created_at', 'source_updated_at'], [
      {comparison_project_id: projectId, generation, article_id: 'category-metadata-language', column_id: 'llm:model-category:1100:prompt-category', column_order: 0, kind: 'llm', prompt_id: 'prompt-category', model_id: 'model-category', source_project_id: null, content_key: '1100', display_answer: 'yes', normalized_answers: ['yes'], source_created_at: '2026-09-01T02:00:00.000Z', source_updated_at: '2026-09-01T03:00:00.000Z'},
      {comparison_project_id: projectId, generation, article_id: 'category-cjk-title', column_id: 'llm:model-category:1100:prompt-category', column_order: 0, kind: 'llm', prompt_id: 'prompt-category', model_id: 'model-category', source_project_id: null, content_key: '1100', display_answer: 'yes', normalized_answers: ['yes'], source_created_at: '2026-09-02T02:00:00.000Z', source_updated_at: '2026-09-02T03:00:00.000Z'},
      {comparison_project_id: projectId, generation, article_id: 'category-cjk-abstract', column_id: 'llm:model-category:1100:prompt-category', column_order: 0, kind: 'llm', prompt_id: 'prompt-category', model_id: 'model-category', source_project_id: null, content_key: '1100', display_answer: 'yes', normalized_answers: ['yes'], source_created_at: '2026-09-03T02:00:00.000Z', source_updated_at: '2026-09-03T03:00:00.000Z'},
      {comparison_project_id: projectId, generation, article_id: 'category-non-chinese', column_id: 'llm:model-category:1100:prompt-category', column_order: 0, kind: 'llm', prompt_id: 'prompt-category', model_id: 'model-category', source_project_id: null, content_key: '1100', display_answer: 'yes', normalized_answers: ['yes'], source_created_at: '2026-09-04T02:00:00.000Z', source_updated_at: '2026-09-04T03:00:00.000Z'}
    ])

    await builder.insertComparisonProjectServingRollups(
      {comparisonProjectId: projectId, generation},
      {queryJson: database.queryJson, run: database.run}
    )

    const articleRows = await database.queryJson(\`
      SELECT
        article_id AS articleId,
        article_category AS articleCategory
      FROM mart.comparison_article_serving
      WHERE comparison_project_id = '\${projectId}'
      ORDER BY article_id ASC
    \`)

    console.log(JSON.stringify({articleRows}))
  `
}

const getRequiredColumnStabilityScript = () => {
  return `
    const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
    const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
    const {
      comparisonProjectServingGenerationConfigTables,
      ensureComparisonProjectServingGenerationConfig,
    } = await import('./src/server/services/comparisonProjectServingGenerationConfig.ts')

    await migrateDuckdb()

    const database = getAppDatabaseService()
    const runner = {queryJson: database.queryJson, run: database.run}
    const promptProjectId = 'comparison-required-prompt-columns'
    const summaryProjectId = 'comparison-required-summary-columns'

    await database.run(\`
      INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
      VALUES ('provider-required-columns', 'sglang', 'Provider Required Columns', TRUE, 'none', 'http://localhost:30001/v1')
    \`)

    await database.run(\`
      INSERT INTO app.model (
        id,
        provider_connection_id,
        name,
        remote_model_id,
        display_name,
        variant,
        source,
        enabled,
        metadata_json
      ) VALUES
        ('model-a', 'provider-required-columns', 'Model A', 'model-a', 'Model A', 'manual', 'manual', TRUE, '{}'::JSON),
        ('model-b', 'provider-required-columns', 'Model B', 'model-b', 'Model B', 'manual', 'manual', TRUE, '{}'::JSON)
    \`)

    await database.run(\`
      INSERT INTO app.prompt (id, original_text, prompt_heading, type, content_hash, created_at)
      VALUES
        ('prompt-required-a', 'Prompt Required A', 'Prompt Required A', NULL, 'prompt-required-a-hash', TIMESTAMPTZ '2026-10-01T00:00:00.000Z'),
        ('prompt-required-b', 'Prompt Required B', 'Prompt Required B', NULL, 'prompt-required-b-hash', TIMESTAMPTZ '2026-10-02T00:00:00.000Z'),
        ('prompt-summary-a', 'Prompt Summary A', 'Prompt Summary A', NULL, 'prompt-summary-a-hash', TIMESTAMPTZ '2026-10-03T00:00:00.000Z'),
        ('prompt-summary-b', 'Prompt Summary B', 'Prompt Summary B', NULL, 'prompt-summary-b-hash', TIMESTAMPTZ '2026-10-04T00:00:00.000Z')
    \`)

    await database.run(\`
      INSERT INTO app.project (
        id,
        name,
        description,
        model_id,
        human_judgment_mode,
        use_title,
        use_abstract,
        use_fulltext,
        use_fulltext_no_images
      ) VALUES
        ('source-project-a', 'Source Project A', NULL, 'model-a', 'summary', TRUE, TRUE, FALSE, FALSE),
        ('source-project-b', 'Source Project B', NULL, 'model-b', 'summary', TRUE, TRUE, FALSE, FALSE)
    \`)

    await database.run(\`
      INSERT INTO app.project_prompt (
        id,
        project_id,
        prompt_id,
        prompt_order,
        enabled,
        criteria_disposition,
        criteria_section_key,
        criteria_section_label
      ) VALUES
        ('source-project-a-summary-prompt', 'source-project-a', 'prompt-summary-a', 0, TRUE, 'include', 'population', 'Population'),
        ('source-project-b-summary-prompt', 'source-project-b', 'prompt-summary-b', 0, TRUE, 'include', 'population', 'Population')
    \`)

    await database.run(\`
      INSERT INTO app.comparison_project (
        id,
        name,
        description,
        model_ids,
        compare_with_humans,
        human_judgment_mode,
        summary_source_project_id,
        use_title,
        use_abstract,
        use_fulltext,
        use_fulltext_no_images
      ) VALUES
        ('\${promptProjectId}', 'Required Prompt Columns', NULL, ['model-a'], TRUE, 'prompt', NULL, TRUE, TRUE, FALSE, FALSE),
        ('\${summaryProjectId}', 'Required Summary Columns', NULL, ['model-a', 'model-b'], TRUE, 'summary', 'source-project-a', TRUE, TRUE, FALSE, FALSE)
    \`)

    await database.run(\`
      INSERT INTO app.comparison_project_prompt (
        id,
        comparison_project_id,
        prompt_id,
        prompt_order,
        criteria_disposition,
        criteria_section_key,
        criteria_section_label
      ) VALUES
        ('comparison-required-prompt-a', '\${promptProjectId}', 'prompt-required-a', 0, NULL, NULL, NULL),
        ('comparison-required-summary-fallback', '\${summaryProjectId}', 'prompt-summary-a', 0, 'include', 'population', 'Population')
    \`)

    await database.run(\`
      INSERT INTO app.comparison_project_source_project (id, comparison_project_id, source_project_id, created_at)
      VALUES ('comparison-required-summary-source-a', '\${summaryProjectId}', 'source-project-a', TIMESTAMPTZ '2026-10-01T00:00:00.000Z')
    \`)

    await ensureComparisonProjectServingGenerationConfig({comparisonProjectId: promptProjectId, generation: 1}, runner)
    await ensureComparisonProjectServingGenerationConfig({comparisonProjectId: summaryProjectId, generation: 1}, runner)

    await database.run(\`
      UPDATE app.comparison_project
      SET model_ids = ['model-b']
      WHERE id = '\${promptProjectId}'
    \`)

    await database.run(\`
      INSERT INTO app.comparison_project_prompt (
        id,
        comparison_project_id,
        prompt_id,
        prompt_order,
        criteria_disposition,
        criteria_section_key,
        criteria_section_label
      ) VALUES ('comparison-required-prompt-b', '\${promptProjectId}', 'prompt-required-b', 1, NULL, NULL, NULL)
    \`)

    await database.run(\`
      INSERT INTO app.comparison_project_source_project (id, comparison_project_id, source_project_id, created_at)
      VALUES ('comparison-required-summary-source-b', '\${summaryProjectId}', 'source-project-b', TIMESTAMPTZ '2026-10-02T00:00:00.000Z')
    \`)

    const actualRows = await database.queryJson(\`
      SELECT
        comparison_project_id AS comparisonProjectId,
        column_id AS columnId,
        kind,
        prompt_id AS promptId
      FROM \${comparisonProjectServingGenerationConfigTables.requiredColumn}
      WHERE comparison_project_id IN ('\${promptProjectId}', '\${summaryProjectId}')
        AND generation = 1
      ORDER BY comparison_project_id ASC, column_id ASC
    \`)

    console.log(JSON.stringify({actualRows}))
  `
}

const runScript = <T>(body: string) => {
  const duckdbPath = `/tmp/f1-comparison-project-serving-rollups-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}.duckdb`
  const runResult = globalThis.Bun.spawnSync(['bun', '-e', body], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      API_SERVER_PORT: '3001',
      DUCKDB_PATH: duckdbPath,
      SERVER_ROLE: 'dev-single',
      VITE_PORT: '3000',
    },
  })

  try {
    if (runResult.exitCode !== 0) {
      throw new Error(
        runResult.stderr.toString() || runResult.stdout.toString() || 'Comparison serving rollup builder test failed',
      )
    }

    return JSON.parse(getLastJsonLine(runResult.stdout.toString())) as T
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
  }
}

test('filter member inserts are disabled for bounded serving rebuilds', async () => {
  const statements: string[] = []
  const builder = getComparisonProjectServingRollupBuilder()

  await builder.insertComparisonProjectFilterMembers(
    {comparisonProjectId: 'comparison-serving-split-project', generation: 1},
    {
      run: async (statement) => {
        statements.push(statement)
      },
    },
  )

  expect(statements).toEqual([])
})

test('article rollup inserts are batched by article id', async () => {
  const statements: string[] = []
  const queryStatements: string[] = []
  const builder = getComparisonProjectServingRollupBuilder()
  const firstRows = Array.from({length: 1001}, (_, index) => {
    return {articleId: `article-${String(index).padStart(4, '0')}`}
  })
  const secondRows = [{articleId: 'article-1000'}]
  const queryResults = [firstRows, secondRows]

  await builder.insertComparisonProjectArticleRollups(
    {comparisonProjectId: 'comparison-serving-batched-rollup-project', generation: 1},
    {
      queryJson: async <T>(statement: string): Promise<T[]> => {
        queryStatements.push(statement)
        return statement.includes('SELECT rollup_scoped_article.article_id AS articleId')
          ? ((queryResults.shift() ?? []) as T[])
          : ([] as T[])
      },
      run: async (statement) => {
        statements.push(statement)
      },
    },
  )

  const batchQueryStatements = queryStatements.filter((statement) => {
    return statement.includes('SELECT rollup_scoped_article.article_id AS articleId')
  })
  const articleInsertStatements = statements.filter((statement) => {
    return statement.includes('INSERT INTO mart.comparison_article_serving')
  })

  expect(batchQueryStatements).toHaveLength(2)
  expect(
    statements.some((statement) => {
      return statement.includes('comparison_serving_generation_required_column_config')
    }),
  ).toBe(true)
  expect(articleInsertStatements).toHaveLength(2)
  expect(articleInsertStatements[0]).toContain("('article-0000')")
  expect(articleInsertStatements[0]).not.toContain("('article-1000')")
  expect(articleInsertStatements[1]).toContain("('article-1000')")
  expect(articleInsertStatements[0]).toContain('INNER JOIN article_batch ON article_batch.article_id = cell.article_id')
})

test('filter stats inserts are split by filter combination', async () => {
  const statements: string[] = []
  const builder = getComparisonProjectServingRollupBuilder()
  const expectedPairs = comparisonProjectRowFilters.flatMap((rowFilter) => {
    return differenceFilters.map((differenceFilter) => {
      return {differenceFilter, rowFilter}
    })
  })

  await builder.insertComparisonProjectFilterStats(
    {comparisonProjectId: 'comparison-serving-split-stats-project', generation: 1},
    {
      run: async (statement) => {
        statements.push(statement)
      },
    },
  )

  expect(statements).toHaveLength(expectedPairs.length)
  expect(
    statements.map((statement) => {
      return (statement.match(/VALUES \('[^']+'\)/g) ?? []).slice(0, 2)
    }),
  ).toEqual(
    expectedPairs.map((pair) => {
      return [`VALUES ('${pair.rowFilter}')`, `VALUES ('${pair.differenceFilter}')`]
    }),
  )
})

test('serving rollups, filter members, and stats match current page and export filters', () => {
  const result = runScript<RollupBuilderResult>(getRollupScript())
  const actualArticleRowsByProjectAndArticle = result.articleRows.reduce<Map<string, ActualArticleRollup>>(
    (rowMap, row) => {
      rowMap.set(`${row.comparisonProjectId}:${row.articleId}`, row)
      return rowMap
    },
    new Map<string, ActualArticleRollup>(),
  )
  const actualStatsByFilter = result.statsRows.reduce<Map<string, ActualFilterStats>>((rowMap, row) => {
    rowMap.set(`${row.comparisonProjectId}:${row.rowFilter}:${row.differenceFilter}`, row)
    return rowMap
  }, new Map<string, ActualFilterStats>())

  fixtureProjects.forEach((project) => {
    const expectedRollups = getExpectedArticleRollups(project)

    project.articles.forEach((article) => {
      const expectedRollup = expectedRollups[article.id]

      expect(expectedRollup).toBeDefined()
      if (expectedRollup === undefined) {
        return
      }

      expect(actualArticleRowsByProjectAndArticle.get(`${project.id}:${article.id}`)).toEqual({
        comparisonProjectId: project.id,
        ...expectedRollup,
      })
    })

    comparisonProjectRowFilters.forEach((rowFilter) => {
      differenceFilters.forEach((differenceFilter) => {
        const key = `${project.id}:${rowFilter}:${differenceFilter}`
        const expectedArticleIds = getExpectedArticleIds(project, rowFilter, differenceFilter)

        expect(actualStatsByFilter.get(key)?.totalCount).toBe(expectedArticleIds.length)
      })
    })
  })

  expect(result.memberRows).toEqual([])
})

test('serving rollups materialize human vs llm true conflicts', () => {
  const result = runScript<TrueConflictRollupResult>(getTrueConflictRollupScript())
  const expectedArticleRows = trueConflictCases
    .map((testCase) => {
      return {
        articleId: testCase.articleId,
        hasHumanVsLlmTrueConflict: testCase.hasTrueConflict,
        passesDifferenceFilterHumanVsLlmTrueConflict: testCase.hasTrueConflict,
      }
    })
    .sort((left, right) => {
      return left.articleId.localeCompare(right.articleId)
    })
  const expectedTrueConflictCount = trueConflictCases.filter((testCase) => {
    return testCase.hasTrueConflict
  }).length

  expect(result.articleRows).toEqual(expectedArticleRows)
  expect(result.memberRows).toEqual([])
  expect(result.statsRows).toEqual([{totalCount: expectedTrueConflictCount}])
})

test('serving rollups materialize article language categories', () => {
  const result = runScript<ArticleCategoryRollupResult>(getArticleCategoryRollupScript())

  expect(result.articleRows).toEqual([
    {articleCategory: 'chinese', articleId: 'category-cjk-abstract'},
    {articleCategory: 'chinese', articleId: 'category-cjk-title'},
    {articleCategory: 'chinese', articleId: 'category-metadata-language'},
    {articleCategory: 'non_chinese', articleId: 'category-non-chinese'},
  ])
})

test('serving rollups use selected scoped import external ids and merged metadata', () => {
  const result = runScript<ScopedImportRollupResult>(getScopedImportRollupScript())

  expect(result.articleRows).toEqual([
    {
      articleExternalId: 'legacy-article-id',
      canonicalOnly: 'canonical',
      comparisonProjectId: 'comparison-no-scope',
      journalTitle: 'Canonical Journal',
      sameValue: 'canonical',
      scopedOnly: null,
    },
    {
      articleExternalId: 'external-route-a',
      canonicalOnly: 'canonical',
      comparisonProjectId: 'comparison-route-scope',
      journalTitle: 'Route A Journal',
      sameValue: 'route-a',
      scopedOnly: 'route-a',
    },
    {
      articleExternalId: 'external-route-a',
      canonicalOnly: 'canonical',
      comparisonProjectId: 'comparison-source-scope',
      journalTitle: 'Route A Journal',
      sameValue: 'route-a',
      scopedOnly: 'route-a',
    },
  ])
})

test('materialized required columns stay stable for prompt and summary modes', () => {
  const result = runScript<RequiredColumnStabilityResult>(getRequiredColumnStabilityScript())

  expect(result.actualRows).toEqual([
    {
      columnId: 'human:prompt-required-a',
      comparisonProjectId: 'comparison-required-prompt-columns',
      kind: 'human',
      promptId: 'prompt-required-a',
    },
    {
      columnId: 'llm:model-a:1100:prompt-required-a',
      comparisonProjectId: 'comparison-required-prompt-columns',
      kind: 'llm',
      promptId: 'prompt-required-a',
    },
    {
      columnId: 'human:summary',
      comparisonProjectId: 'comparison-required-summary-columns',
      kind: 'human',
      promptId: 'summary',
    },
    {
      columnId: 'llm:source-project-a:model-a:1100:summary',
      comparisonProjectId: 'comparison-required-summary-columns',
      kind: 'llm',
      promptId: 'summary',
    },
  ])
})
