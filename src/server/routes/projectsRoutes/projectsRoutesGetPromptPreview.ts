import {Elysia} from 'elysia'

import {MAX_COMPLETION_TOKENS} from '../../../agent/judge.ts'
import {
  getSinglePromptJudgmentPreviewText,
  getSinglePromptJudgmentRequest,
} from '../../../agent/judge/getSinglePromptJudgmentRequest.ts'
import type {ArticleRecord} from '../../../db/schemaTypes.ts'
import {getProviderModelMetadataPromptTokenLimit} from '../../providers/providerModelMetadata.ts'
import {readReviewServingRows, type ReviewServingReaderResult} from '../../reviewServing/reviewServingReader.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString, getJsonValue, getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {getCurrentReviewConfigHash} from '../../services/reviewServingProjectConfigIdentity.ts'
import {processFulltextForLLM} from '../../utils/fulltextProcessing.ts'
import {assertProjectIsActive} from './projectAccessGuard.ts'

const defaultJudgmentModelContext = 32768
const defaultJudgmentPromptTokenLimit = Math.max(0, defaultJudgmentModelContext - MAX_COMPLETION_TOKENS)

type PromptPreviewServingRow = {
  abstract_text: string | null
  article_id: string
  full_text_preview: string | null
  source_metadata: unknown
}
type PromptPreviewDetailRow = {
  article_created_at: unknown
  article_external_id: string | null
  article_id: string
  article_title: string | null
  article_updated_at: unknown
  arxiv_id: string | null
  biorxiv_id: string | null
  doi: string | null
  full_text_conversion_status: string | null
  full_text_fetched_at: unknown
  full_text_pdf: string | null
  journal_title: string | null
  medrxiv_id: string | null
  pmid: string | null
  publication_year: number | null
  source_metadata: unknown
  url: string | null
}
type PromptPreviewFullTextRow = {fullText: string | null}

const getPromptPreviewWorkloadContext = (params: {maxResultRows?: number; operation: string; projectId: string}) => {
  return {
    fallbackIntent: 'reject' as const,
    maxResultRows: params.maxResultRows,
    projectId: params.projectId,
    routeOrJobKey: `projects.promptPreview.${params.operation}`,
    workloadClass: 'owner.product.promptPreview',
  }
}

const getUnavailablePromptPreview = (input: {
  articleId: string | null
  articleTitle?: string | null
  diagnostics?: ReviewServingReaderResult<PromptPreviewServingRow>['diagnostics'] | null
  reason: string
}) => {
  return {
    data: {
      articleId: input.articleId,
      articleTitle: input.articleTitle ?? null,
      diagnostics: input.diagnostics ?? null,
      previewText: null,
      reason: input.reason,
      status: 'unavailable' as const,
      systemPrompt: null,
      userPrompt: null,
    },
  }
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

const getPromptPreviewArticleDetailFromServing = async (input: {
  articleId: string
  projectId: string
  reviewConfigHash: string | null
}) => {
  return readReviewServingRows<PromptPreviewDetailRow>({
    articleId: input.articleId,
    contractKey: 'review.detail.row',
    estimatedResultRows: 1,
    limit: 1,
    projectId: input.projectId,
    reviewConfigHash: input.reviewConfigHash,
  })
}

const getPromptPreviewArticleFullText = async (params: {articleId: string; projectId: string}) => {
  const rows = await getAppDatabaseService().queryJson<PromptPreviewFullTextRow>(
    `
    SELECT full_text AS fullText
    FROM app.article
    WHERE id = ${getSqlLiteral(params.articleId)}
    LIMIT 1
  `,
    getPromptPreviewWorkloadContext({maxResultRows: 1, operation: 'articleFullText', projectId: params.projectId}),
  )

  return rows[0]?.fullText ?? null
}

const getDateValue = (value: unknown) => {
  return value instanceof Date ? value : typeof value === 'string' || typeof value === 'number' ? new Date(value) : null
}

const getPromptPreviewArticleRecord = (input: {
  detail: PromptPreviewDetailRow
  fullText: string | null
  payload: PromptPreviewServingRow
}): ArticleRecord => {
  const sourceMetadata = input.payload.source_metadata ?? input.detail.source_metadata

  return {
    articleAuthors: null,
    articleCreatedAt: getDateValue(input.detail.article_created_at),
    articleId: input.detail.article_external_id,
    articleSummary: input.payload.abstract_text,
    articleTitle: input.detail.article_title ?? '',
    articleUpdatedAt: getDateValue(input.detail.article_updated_at),
    articleVersion: null,
    arxivId: input.detail.arxiv_id,
    biorxivId: input.detail.biorxiv_id,
    contentHash: null,
    createdAt: new Date(0),
    doi: input.detail.doi,
    fullText: input.fullText,
    fullTextAssets: null,
    fullTextCharCount: input.fullText?.length ?? null,
    fullTextConversionAttempts: null,
    fullTextConversionError: null,
    fullTextConversionMetadata: null,
    fullTextConversionModelId: null,
    fullTextConversionStatus: input.detail.full_text_conversion_status,
    fullTextFetchedAt: getDateValue(input.detail.full_text_fetched_at),
    fullTextHtml: null,
    fullTextOriginalFormat: null,
    fullTextPDF: input.detail.full_text_pdf,
    fullTextSource: null,
    id: input.detail.article_id,
    importRoute: null,
    medrxivId: input.detail.medrxiv_id,
    originalData: null,
    publicationStatus: null,
    pubmedId: input.detail.pmid,
    sourceMetadata,
    updatedAt: new Date(0),
    url: input.detail.url,
  }
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
      }>(
        `
        SELECT
          model_id AS modelId,
          use_abstract AS useAbstract,
          use_fulltext AS useFulltext,
          use_fulltext_no_images AS useFulltextNoImages,
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

    const reviewConfigHash = await getCurrentReviewConfigHash(params.id)
    const previewArticleRead = await getFirstProjectArticleFromServing(params.id, reviewConfigHash)
    const previewArticle = previewArticleRead.status === 'accepted' ? (previewArticleRead.rows[0] ?? null) : null

    if (!previewArticle) {
      return getUnavailablePromptPreview({
        articleId: null,
        diagnostics: previewArticleRead.status === 'accepted' ? previewArticleRead.diagnostics : null,
        reason:
          previewArticleRead.status === 'accepted' ? 'no_articles' : previewArticleRead.diagnostics.manifest.freshness,
      })
    }

    const firstArticleId = previewArticle.article_id

    const detailRead = await getPromptPreviewArticleDetailFromServing({
      articleId: firstArticleId,
      projectId: params.id,
      reviewConfigHash,
    })
    const firstArticleDetail = detailRead.status === 'accepted' ? (detailRead.rows[0] ?? null) : null

    if (!firstArticleDetail) {
      return getUnavailablePromptPreview({
        articleId: firstArticleId,
        diagnostics: detailRead.status === 'accepted' ? detailRead.diagnostics : previewArticleRead.diagnostics,
        reason:
          detailRead.status === 'accepted' ? 'serving_detail_unavailable' : detailRead.diagnostics.manifest.freshness,
      })
    }

    const modelRow = await getAppDatabaseService().queryJson<{modelMetadataJson: unknown; provider: string | null}>(
      `
        SELECT
          TO_JSON(m.metadata_json) AS modelMetadataJson,
          pc.provider_kind AS provider
        FROM app.model m
        LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
        WHERE m.id = '${escapeSqlString(projectRow.modelId)}'
        LIMIT 1
      `,
      getPromptPreviewWorkloadContext({maxResultRows: 1, operation: 'modelMetadata', projectId: params.id}),
    )

    const [projectModel] = modelRow
    const modelContext =
      getProviderModelMetadataPromptTokenLimit(getJsonValue(projectModel?.modelMetadataJson), MAX_COMPLETION_TOKENS)
      ?? defaultJudgmentPromptTokenLimit
    const needsFulltext = projectRow.useFulltext || projectRow.useFulltextNoImages
    const previewFullText = needsFulltext
      ? await getPromptPreviewArticleFullText({articleId: firstArticleId, projectId: params.id})
      : null
    const fullTextResult =
      needsFulltext && previewFullText
        ? processFulltextForLLM(previewFullText, {
            promptTokenLimit: modelContext,
            stripImages: projectRow.useFulltextNoImages,
          }).processedText
        : null
    const firstArticle = getPromptPreviewArticleRecord({
      detail: firstArticleDetail,
      fullText: fullTextResult,
      payload: previewArticle,
    })

    if (needsFulltext && !fullTextResult) {
      return getUnavailablePromptPreview({
        articleId: firstArticle.id,
        articleTitle: firstArticle.articleTitle,
        diagnostics: previewArticleRead.status === 'accepted' ? previewArticleRead.diagnostics : null,
        reason: 'no_fulltext',
      })
    }

    const {systemPrompt, userPrompt} = getSinglePromptJudgmentRequest({
      article: firstArticle,
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
        articleId: firstArticle.id,
        articleTitle: firstArticle.articleTitle,
        diagnostics: previewArticleRead.status === 'accepted' ? previewArticleRead.diagnostics : null,
        previewText: getSinglePromptJudgmentPreviewText({systemPrompt, userPrompt}),
        reason: null,
        status: 'ready' as const,
        systemPrompt,
        userPrompt,
      },
    }
  },
)
