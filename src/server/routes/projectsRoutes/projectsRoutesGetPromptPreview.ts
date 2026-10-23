import {Elysia} from 'elysia'

import {MAX_COMPLETION_TOKENS} from '../../../agent/judge.ts'
import {
  getSinglePromptJudgmentPreviewText,
  getSinglePromptJudgmentRequest,
} from '../../../agent/judge/getSinglePromptJudgmentRequest.ts'
import {getSinglePromptSystemPromptForArticle} from '../../../agent/judge/judgePromptSelection.ts'
import {getSystemPromptVariant} from '../../../agent/judge/systemPromptVariant.ts'
import {isFullTextJudgingStrategy} from '../../cron/judgmentsJobs/judgmentsJobsSendToLLM/prepareFullTextJudging.ts'
import {getEffectiveFullTextStrategyId} from '../../fullText/fullTextStrategy.ts'
import {getProviderModelContextLimits} from '../../providers/providerModelCapabilities.ts'
import {readReviewServingRows} from '../../reviewServing/reviewServingReader.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString, getJsonValue} from '../../services/appQueryHelpers.ts'
import {getCurrentReviewConfigHash} from '../../services/reviewServingProjectConfigIdentity.ts'
import {assertProjectIsActive} from './projectAccessGuard.ts'
import {getPromptPreviewArticleDetails} from './projectsRoutesGetPromptPreview/getPromptPreviewArticleDetails.ts'
import {getPromptPreviewArticleRecord} from './projectsRoutesGetPromptPreview/getPromptPreviewArticleRecord.ts'
import {getPromptPreviewFullTextPreparation} from './projectsRoutesGetPromptPreview/getPromptPreviewFullTextPreparation.ts'
import {getPromptPreviewWorkloadContext} from './projectsRoutesGetPromptPreview/getPromptPreviewWorkloadContext.ts'
import {getScientificArticlePlaceholderRecord} from './projectsRoutesGetPromptPreview/getScientificArticlePlaceholderRecord.ts'
import {getUnavailablePromptPreview} from './projectsRoutesGetPromptPreview/getUnavailablePromptPreview.ts'
import type {PromptPreviewServingRow} from './projectsRoutesGetPromptPreview/promptPreviewServingRow.ts'

const getPromptPreviewProjectModel = async (params: {modelId: string; projectId: string}) => {
  const rows = await getAppDatabaseService().queryJson<{
    modelMetadataJson: unknown
    provider: string | null
    remoteModelId: string | null
  }>(
    `
      SELECT
        TO_JSON(m.metadata_json) AS modelMetadataJson,
        pc.provider_kind AS provider,
        m.remote_model_id AS remoteModelId
      FROM app.model m
      LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
      WHERE m.id = '${escapeSqlString(params.modelId)}'
      LIMIT 1
    `,
    getPromptPreviewWorkloadContext({maxResultRows: 1, operation: 'modelMetadata', projectId: params.projectId}),
  )

  return rows[0] ?? null
}

const getFirstProjectArticleFromServing = async (projectId: string, reviewConfigHash: string | null) => {
  return readReviewServingRows<PromptPreviewServingRow>({
    contractKey: 'review.prompt.preview',
    estimatedResultRows: 1,
    limit: 1,
    projectId,
    reviewConfigHash,
  })
}

export const projectsRoutesGetPromptPreview = new Elysia().get(
  '/api/projects/:id/prompts/:promptId/preview',
  async ({params}) => {
    await assertProjectIsActive(params.id)

    const [project, prompt] = await Promise.all([
      getAppDatabaseService().queryJson<{
        fullTextStrategyId: string | null
        modelId: string
        systemPromptVariant: string | null
        useAbstract: boolean
        useFulltext: boolean
        useFulltextNoImages: boolean
        useMetadata: boolean | null
        useTitle: boolean
      }>(
        `
        SELECT
          full_text_strategy_id AS fullTextStrategyId,
          model_id AS modelId,
          system_prompt_variant AS systemPromptVariant,
          use_abstract AS useAbstract,
          use_fulltext AS useFulltext,
          use_fulltext_no_images AS useFulltextNoImages,
          use_metadata AS useMetadata,
          use_title AS useTitle
        FROM app.project
        WHERE id = '${escapeSqlString(params.id)}'
        LIMIT 1
      `,
        getPromptPreviewWorkloadContext({maxResultRows: 1, operation: 'projectConfig', projectId: params.id}),
      ),
      getAppDatabaseService().queryJson<{
        id: string
        originalText: string
        promptHeading: string | null
        type: string | null
      }>(
        `
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
      `,
        getPromptPreviewWorkloadContext({maxResultRows: 1, operation: 'promptLookup', projectId: params.id}),
      ),
    ])

    const [projectRow] = project
    const [promptRow] = prompt

    if (!projectRow) {
      throw new Error('Project not found')
    }

    if (!promptRow) {
      throw new Error('Prompt not found or not enabled for this project')
    }

    const systemPromptVariant = getSystemPromptVariant(projectRow.systemPromptVariant)
    const projectModel = await getPromptPreviewProjectModel({modelId: projectRow.modelId, projectId: params.id})
    const provider = projectModel?.provider ?? null
    const reviewConfigHash = await getCurrentReviewConfigHash(params.id)
    const previewArticleRead = await getFirstProjectArticleFromServing(params.id, reviewConfigHash)
    const previewArticle = previewArticleRead.status === 'accepted' ? (previewArticleRead.rows[0] ?? null) : null

    if (!previewArticle) {
      return getUnavailablePromptPreview({
        articleId: null,
        diagnostics: previewArticleRead.status === 'accepted' ? previewArticleRead.diagnostics : null,
        reason:
          previewArticleRead.status === 'accepted' ? 'no_articles' : previewArticleRead.diagnostics.manifest.freshness,
        systemPrompt: getSinglePromptSystemPromptForArticle(
          getScientificArticlePlaceholderRecord(),
          provider,
          systemPromptVariant,
        ),
        systemPromptVariant,
      })
    }

    const firstArticleId = previewArticle.article_id
    const modelContext = getProviderModelContextLimits({
      model: {
        metadataJson: getJsonValue(projectModel?.modelMetadataJson),
        providerKind: provider,
        remoteModelId: projectModel?.remoteModelId ?? null,
      },
      reservedCompletionTokens: MAX_COMPLETION_TOKENS,
    }).promptTokenLimit
    const fullTextStrategyId = getEffectiveFullTextStrategyId(projectRow.fullTextStrategyId)
    const needsFulltext = isFullTextJudgingStrategy(fullTextStrategyId)

    if (needsFulltext && modelContext === null) {
      return getUnavailablePromptPreview({
        articleId: previewArticle.article_id,
        articleTitle: previewArticle.article_title,
        diagnostics: previewArticleRead.status === 'accepted' ? previewArticleRead.diagnostics : null,
        reason: 'model_context_window_missing',
        systemPrompt: getSinglePromptSystemPromptForArticle(
          getScientificArticlePlaceholderRecord(),
          provider,
          systemPromptVariant,
        ),
        systemPromptVariant,
      })
    }
    const useMetadata = projectRow.useMetadata === true
    const previewArticleDetails =
      needsFulltext || useMetadata
        ? await getPromptPreviewArticleDetails({
            articleId: firstArticleId,
            includeFullText: needsFulltext,
            projectId: params.id,
          })
        : null
    const previewFullText = previewArticleDetails?.fullText ?? null
    const firstArticle = getPromptPreviewArticleRecord({
      fullText: null,
      publicationStatus: previewArticleDetails?.publicationStatus ?? null,
      row: previewArticle,
    })

    if (needsFulltext && !previewFullText) {
      return getUnavailablePromptPreview({
        articleId: firstArticle.id,
        articleTitle: firstArticle.articleTitle,
        diagnostics: previewArticleRead.status === 'accepted' ? previewArticleRead.diagnostics : null,
        reason: 'no_fulltext',
        systemPrompt: getSinglePromptSystemPromptForArticle(firstArticle, provider, systemPromptVariant),
        systemPromptVariant,
      })
    }

    const fullTextPreparation =
      needsFulltext && previewFullText && modelContext !== null
        ? await getPromptPreviewFullTextPreparation({
            article: firstArticle,
            details: previewArticleDetails,
            fullText: previewFullText,
            fullTextStrategyId,
            modelContext,
            modelName: projectModel?.remoteModelId ?? projectRow.modelId,
          })
        : null

    if (fullTextPreparation && fullTextPreparation.kind !== 'ready') {
      return getUnavailablePromptPreview({
        articleId: firstArticle.id,
        articleTitle: firstArticle.articleTitle,
        detail: fullTextPreparation.message,
        diagnostics: previewArticleRead.status === 'accepted' ? previewArticleRead.diagnostics : null,
        reason: 'full_text_not_ready',
        systemPrompt: getSinglePromptSystemPromptForArticle(firstArticle, provider, systemPromptVariant),
        systemPromptVariant,
      })
    }

    const {systemPrompt, userPrompt} = getSinglePromptJudgmentRequest({
      article: firstArticle,
      contentSettings: {
        useAbstract: projectRow.useAbstract,
        useFulltext: projectRow.useFulltext,
        useFulltextNoImages: projectRow.useFulltextNoImages,
        useMetadata,
        useTitle: projectRow.useTitle,
      },
      prompt: {...promptRow, order: null},
      provider,
      renderedFullText: fullTextPreparation?.kind === 'ready' ? fullTextPreparation.fullTextJudging.renderedText : null,
      systemPromptVariant,
    })

    return {
      data: {
        articleId: firstArticle.id,
        articleTitle: firstArticle.articleTitle,
        detail: null,
        diagnostics: previewArticleRead.status === 'accepted' ? previewArticleRead.diagnostics : null,
        previewText: getSinglePromptJudgmentPreviewText({systemPrompt, userPrompt}),
        reason: null,
        status: 'ready' as const,
        systemPrompt,
        systemPromptVariant,
        userPrompt,
      },
    }
  },
)
