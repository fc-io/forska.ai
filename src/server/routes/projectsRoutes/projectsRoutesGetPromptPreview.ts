import {Elysia} from 'elysia'

import {MAX_COMPLETION_TOKENS} from '../../../agent/judge.ts'
import {
  getSinglePromptJudgmentPreviewText,
  getSinglePromptJudgmentRequest,
} from '../../../agent/judge/getSinglePromptJudgmentRequest.ts'
import {prepareLiveArticleForJudging} from '../../cron/judgmentsJobs/judgmentsJobsSendToLLM/prepareLiveArticleForJudging.ts'
import {getProviderModelMetadataPromptTokenLimit} from '../../providers/providerModelMetadata.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString, getJsonValue} from '../../services/appQueryHelpers.ts'
import {getAppQueryService} from '../../services/getAppQueryService.ts'
import {assertProjectIsActive} from './projectAccessGuard.ts'

const defaultJudgmentModelContext = 32768
const defaultJudgmentPromptTokenLimit = Math.max(0, defaultJudgmentModelContext - MAX_COMPLETION_TOKENS)

const getFirstProjectArticleId = async (projectId: string) => {
  const [scopeRow] = await getAppDatabaseService().queryJson<{articleId: string}>(`
    SELECT article_id AS articleId
    FROM mart.project_scope_article
    WHERE project_id = '${escapeSqlString(projectId)}'
    ORDER BY article_created_at ASC NULLS LAST, article_id ASC
    LIMIT 1
  `)

  if (scopeRow) {
    return scopeRow.articleId
  }

  const [ordinalRow] = await getAppDatabaseService().queryJson<{articleId: string}>(`
    SELECT article_id AS articleId
    FROM app.project_article_ordinal
    WHERE project_id = '${escapeSqlString(projectId)}'
    ORDER BY article_seq ASC
    LIMIT 1
  `)

  if (ordinalRow) {
    return ordinalRow.articleId
  }

  const [fallbackRow] = await getAppDatabaseService().queryJson<{articleId: string}>(`
    SELECT article_id AS articleId
    FROM app.project_article
    WHERE project_id = '${escapeSqlString(projectId)}'
    ORDER BY article_id ASC
    LIMIT 1
  `)

  return fallbackRow?.articleId ?? null
}

export const projectsRoutesGetPromptPreview = new Elysia().get(
  '/api/projects/:id/prompts/:promptId/preview',
  async ({params}) => {
    await assertProjectIsActive(params.id)

    const [project, prompt] = await Promise.all([
      getAppDatabaseService().queryJson<{
        modelId: string
        useAbstract: boolean
        useFulltext: boolean
        useFulltextNoImages: boolean
        useTitle: boolean
      }>(`
        SELECT
          model_id AS modelId,
          use_abstract AS useAbstract,
          use_fulltext AS useFulltext,
          use_fulltext_no_images AS useFulltextNoImages,
          use_title AS useTitle
        FROM app.project
        WHERE id = '${escapeSqlString(params.id)}'
        LIMIT 1
      `),
      getAppDatabaseService().queryJson<{
        id: string
        originalText: string
        promptHeading: string | null
        type: string | null
      }>(`
        SELECT
          p.id AS id,
          p.original_text AS originalText,
          p.prompt_heading AS promptHeading,
          p.type AS type
        FROM app.project_prompt pp
        INNER JOIN app.prompt p ON p.id = pp.prompt_id
        WHERE pp.project_id = '${escapeSqlString(params.id)}'
          AND pp.prompt_id = '${escapeSqlString(params.promptId)}'
          AND pp.enabled = TRUE
        LIMIT 1
      `),
    ])

    const [projectRow] = project
    const [promptRow] = prompt

    if (!projectRow) {
      throw new Error('Project not found')
    }

    if (!promptRow) {
      throw new Error('Prompt not found or not enabled for this project')
    }

    const firstArticleId = await getFirstProjectArticleId(params.id)

    if (!firstArticleId) {
      return {
        data: {
          articleId: null,
          articleTitle: null,
          previewText: null,
          reason: 'no_articles' as const,
          status: 'unavailable' as const,
          systemPrompt: null,
          userPrompt: null,
        },
      }
    }

    const [modelRow, article] = await Promise.all([
      getAppDatabaseService().queryJson<{modelMetadataJson: unknown; provider: string | null}>(`
        SELECT
          TO_JSON(m.metadata_json) AS modelMetadataJson,
          pc.provider_kind AS provider
        FROM app.model m
        LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
        WHERE m.id = '${escapeSqlString(projectRow.modelId)}'
        LIMIT 1
      `),
      getAppQueryService().getFullArticlesByIds([firstArticleId], {
        includeFullText: projectRow.useFulltext || projectRow.useFulltextNoImages,
        projectId: params.id,
      }),
    ])

    const [projectModel] = modelRow
    const [firstArticle] = article

    if (!firstArticle) {
      return {
        data: {
          articleId: firstArticleId,
          articleTitle: null,
          previewText: null,
          reason: 'no_articles' as const,
          status: 'unavailable' as const,
          systemPrompt: null,
          userPrompt: null,
        },
      }
    }

    const modelContext =
      getProviderModelMetadataPromptTokenLimit(getJsonValue(projectModel?.modelMetadataJson), MAX_COMPLETION_TOKENS)
      ?? defaultJudgmentPromptTokenLimit
    const preparedArticle = await prepareLiveArticleForJudging({
      article: firstArticle,
      modelContext,
      useFulltext: projectRow.useFulltext,
      useFulltextNoImages: projectRow.useFulltextNoImages,
    })

    if (preparedArticle.kind === 'skipped') {
      return {
        data: {
          articleId: firstArticle.id,
          articleTitle: firstArticle.articleTitle,
          previewText: null,
          reason: preparedArticle.skipReason,
          status: 'unavailable' as const,
          systemPrompt: null,
          userPrompt: null,
        },
      }
    }

    if (preparedArticle.kind === 'retry') {
      return {
        data: {
          articleId: firstArticle.id,
          articleTitle: firstArticle.articleTitle,
          previewText: null,
          reason: 'transient_failure' as const,
          status: 'unavailable' as const,
          systemPrompt: null,
          userPrompt: null,
        },
      }
    }

    const {systemPrompt, userPrompt} = getSinglePromptJudgmentRequest({
      article: preparedArticle.article,
      contentSettings: {
        useAbstract: projectRow.useAbstract,
        useFulltext: projectRow.useFulltext,
        useFulltextNoImages: projectRow.useFulltextNoImages,
        useTitle: projectRow.useTitle,
      },
      prompt: {...promptRow, order: null},
      provider: projectModel?.provider ?? null,
    })

    return {
      data: {
        articleId: preparedArticle.article.id,
        articleTitle: preparedArticle.article.articleTitle,
        previewText: getSinglePromptJudgmentPreviewText({systemPrompt, userPrompt}),
        reason: null,
        status: 'ready' as const,
        systemPrompt,
        userPrompt,
      },
    }
  },
)
