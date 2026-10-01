import {Elysia} from 'elysia'

import {MAX_COMPLETION_TOKENS} from '../../../agent/judge.ts'
import {
  getSinglePromptJudgmentPreviewText,
  getSinglePromptJudgmentRequest,
} from '../../../agent/judge/getSinglePromptJudgmentRequest.ts'
import {getSinglePromptSystemPromptForArticle} from '../../../agent/judge/judgePromptSelection.ts'
import {getSystemPromptVariant, type SystemPromptVariant} from '../../../agent/judge/systemPromptVariant.ts'
import type {ArticleRecord} from '../../../db/schemaTypes.ts'
import {getProviderModelMetadataPromptTokenLimit} from '../../providers/providerModelMetadata.ts'
import type {ReviewServingFreshnessState} from '../../reviewServing/reviewServingContracts.ts'
import {readReviewServingRows, type ReviewServingReaderResult} from '../../reviewServing/reviewServingReader.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString, getJsonValue, getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {getCurrentReviewConfigHash} from '../../services/reviewServingProjectConfigIdentity.ts'
import {processFulltextForLLM} from '../../utils/fulltextProcessing.ts'
import {assertProjectIsActive} from './projectAccessGuard.ts'

const defaultJudgmentModelContext = 32768
const defaultJudgmentPromptTokenLimit = Math.max(0, defaultJudgmentModelContext - MAX_COMPLETION_TOKENS)

type PromptPreviewServingRow = {
  article_summary: string | null
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
type PromptPreviewArticleDetailsRow = {fullText: string | null; publicationStatus: string | null}

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
  reason: 'no_articles' | 'no_fulltext' | ReviewServingFreshnessState
  systemPrompt: string
  systemPromptVariant: SystemPromptVariant
}) => {
  return {
    data: {
      articleId: input.articleId,
      articleTitle: input.articleTitle ?? null,
      diagnostics: input.diagnostics ?? null,
      previewText: null,
      reason: input.reason,
      status: 'unavailable' as const,
      systemPrompt: input.systemPrompt,
      systemPromptVariant: input.systemPromptVariant,
      userPrompt: null,
    },
  }
}

const getPromptPreviewProjectModel = async (params: {modelId: string; projectId: string}) => {
  const rows = await getAppDatabaseService().queryJson<{modelMetadataJson: unknown; provider: string | null}>(
    `
      SELECT
        TO_JSON(m.metadata_json) AS modelMetadataJson,
        pc.provider_kind AS provider
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

const getPromptPreviewArticleDetails = async (params: {
  articleId: string
  includeFullText: boolean
  projectId: string
}) => {
  const rows = await getAppDatabaseService().queryJson<PromptPreviewArticleDetailsRow>(
    `
    SELECT
      ${params.includeFullText ? 'full_text' : 'CAST(NULL AS VARCHAR)'} AS fullText,
      publication_status AS publicationStatus
    FROM app.article
    WHERE id = ${getSqlLiteral(params.articleId)}
    LIMIT 1
  `,
    getPromptPreviewWorkloadContext({maxResultRows: 1, operation: 'articleDetails', projectId: params.projectId}),
  )

  return rows[0] ?? null
}

const publicationStatuses = ['preprint', 'submitted', 'accepted', 'published', 'retracted'] as const

const getPublicationStatus = (value: string | null | undefined): ArticleRecord['publicationStatus'] => {
  return (
    publicationStatuses.find((status) => {
      return status === value
    }) ?? null
  )
}

const getDateValue = (value: unknown) => {
  return value instanceof Date ? value : typeof value === 'string' || typeof value === 'number' ? new Date(value) : null
}

const getPromptPreviewArticleRecord = (input: {
  fullText: string | null
  publicationStatus: string | null
  row: PromptPreviewServingRow
}): ArticleRecord => {
  return {
    articleAuthors: null,
    articleCreatedAt: getDateValue(input.row.article_created_at),
    articleId: input.row.article_external_id,
    articleSummary: input.row.article_summary,
    articleTitle: input.row.article_title ?? '',
    articleUpdatedAt: getDateValue(input.row.article_updated_at),
    articleVersion: null,
    arxivId: input.row.arxiv_id,
    biorxivId: input.row.biorxiv_id,
    contentHash: null,
    createdAt: new Date(0),
    doi: input.row.doi,
    fullText: input.fullText,
    fullTextAssets: null,
    fullTextCharCount: input.fullText?.length ?? null,
    fullTextConversionAttempts: null,
    fullTextConversionError: null,
    fullTextConversionMetadata: null,
    fullTextConversionModelId: null,
    fullTextConversionStatus: input.row.full_text_conversion_status,
    fullTextFetchedAt: getDateValue(input.row.full_text_fetched_at),
    fullTextHtml: null,
    fullTextOriginalFormat: null,
    fullTextPDF: input.row.full_text_pdf,
    fullTextSource: null,
    id: input.row.article_id,
    importRoute: null,
    medrxivId: input.row.medrxiv_id,
    originalData: null,
    publicationStatus: getPublicationStatus(input.publicationStatus),
    pubmedId: input.row.pmid,
    sourceMetadata: getJsonValue(input.row.source_metadata),
    updatedAt: new Date(0),
    url: input.row.url,
  }
}

const getScientificArticlePlaceholderRecord = (): ArticleRecord => {
  return {
    articleAuthors: null,
    articleCreatedAt: null,
    articleId: null,
    articleSummary: null,
    articleTitle: '',
    articleUpdatedAt: null,
    articleVersion: null,
    arxivId: null,
    biorxivId: null,
    contentHash: null,
    createdAt: new Date(0),
    doi: null,
    fullText: null,
    fullTextAssets: null,
    fullTextCharCount: null,
    fullTextConversionAttempts: null,
    fullTextConversionError: null,
    fullTextConversionMetadata: null,
    fullTextConversionModelId: null,
    fullTextConversionStatus: null,
    fullTextFetchedAt: null,
    fullTextHtml: null,
    fullTextOriginalFormat: null,
    fullTextPDF: null,
    fullTextSource: null,
    id: '',
    importRoute: null,
    medrxivId: null,
    originalData: null,
    publicationStatus: null,
    pubmedId: null,
    sourceMetadata: null,
    updatedAt: new Date(0),
    url: null,
  }
}

export const projectsRoutesGetPromptPreview = new Elysia().get(
  '/api/projects/:id/prompts/:promptId/preview',
  async ({params}) => {
    await assertProjectIsActive(params.id)

    const [project, prompt] = await Promise.all([
      getAppDatabaseService().queryJson<{
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
    const modelContext =
      getProviderModelMetadataPromptTokenLimit(getJsonValue(projectModel?.modelMetadataJson), MAX_COMPLETION_TOKENS)
      ?? defaultJudgmentPromptTokenLimit
    const needsFulltext = projectRow.useFulltext || projectRow.useFulltextNoImages
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
    const fullTextResult =
      needsFulltext && previewFullText
        ? processFulltextForLLM(previewFullText, {
            promptTokenLimit: modelContext,
            stripImages: projectRow.useFulltextNoImages,
          }).processedText
        : null
    const firstArticle = getPromptPreviewArticleRecord({
      fullText: fullTextResult,
      publicationStatus: previewArticleDetails?.publicationStatus ?? null,
      row: previewArticle,
    })

    if (needsFulltext && !fullTextResult) {
      return getUnavailablePromptPreview({
        articleId: firstArticle.id,
        articleTitle: firstArticle.articleTitle,
        diagnostics: previewArticleRead.status === 'accepted' ? previewArticleRead.diagnostics : null,
        reason: 'no_fulltext',
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
      systemPromptVariant,
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
        systemPromptVariant,
        userPrompt,
      },
    }
  },
)
