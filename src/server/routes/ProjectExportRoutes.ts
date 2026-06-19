import {randomUUID} from 'node:crypto'

import {Elysia, t} from 'elysia'

import {getArticleUrl} from '../../app/utils/getArticleUrl.ts'
import {getArticleSourceMetadataValue} from '../../utils/articleSourceMetadata.ts'
import {createReviewBulkOperationJob} from '../reviewServing/reviewBulkOperationService.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {
  getAndClause,
  getDateValue,
  getJsonValue,
  getJudgmentConfigClause,
  getQuotedStringList,
  getSqlLiteral,
} from '../services/appQueryHelpers.ts'
import {getCurrentReviewConfigHash} from '../services/reviewServingProjectConfigIdentity.ts'
import {createRateLimitedLogger} from '../utils/rateLimitedLogger.ts'
import {withErrorHandler} from '../utils/routeErrorHandler.ts'
import {assertProjectIsActive} from './projectsRoutes/projectAccessGuard.ts'

type PromptDetails = {id: string; promptHeading: string | null; originalText: string | null; type: string | null}
type PromptInfoRow = {prompt: string; title: string; type: string}
type ExportJobRow = {
  criteriaJson: unknown
  resultManifestJson: unknown
  reviewConfigHash: string | null
  status: string
}
type ExportContract = {
  promptOutput?: {
    includeExplanation?: boolean
    includePromptContent?: boolean
    includePromptType?: boolean
    includeQuotes?: boolean
    promptIds?: string[]
  }
  selectedMetadata?: Record<string, boolean | undefined>
}
type ExportArticleRow = {
  arxivId: string | null
  articleAuthors: unknown
  articleCreatedAt: unknown
  articleId: string
  articleOriginalData: unknown
  articleSourceMetadata: unknown
  articleSummary: string | null
  articleTitle: string | null
  articleUpdatedAt: unknown
  articleUrl: string | null
  biorxivId: string | null
  doi: string | null
  medrxivId: string | null
  pubmedId: string | null
}
type ExportJudgmentRow = {
  answeredOriginal: string | null
  answeredOriginalAsArray: unknown
  articleId: string
  explanation: string | null
  promptId: string
  quotes: unknown
}

const appDatabaseService = getAppDatabaseService()
const projectExportLogger = createRateLimitedLogger({sink: 'file-only', windowMs: 30_000})
const exportPayloadBudgetBytes = 10_000_000
const exportBatchSize = 500

const getStringArray = (value: unknown) => {
  return Array.isArray(value)
    ? value.filter((item): item is string => {
        return typeof item === 'string'
      })
    : []
}

const getExportContract = (criteriaJson: unknown): ExportContract => {
  const criteria = getJsonValue(criteriaJson)

  return criteria && typeof criteria === 'object' && !Array.isArray(criteria) && 'exportContract' in criteria
    ? ((criteria as {exportContract?: ExportContract}).exportContract ?? {})
    : {}
}

const getExportArticleIds = (resultManifestJson: unknown) => {
  const manifest = getJsonValue(resultManifestJson)

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || !('batches' in manifest)) {
    return []
  }

  const batches = (manifest as {batches?: unknown}).batches

  return batches && typeof batches === 'object' && !Array.isArray(batches)
    ? Object.values(batches).flatMap(getStringArray)
    : []
}

const formatArticleDate = (value: unknown): string => {
  const dateValue = getDateValue(value)

  return dateValue ? dateValue.toISOString() : ''
}

const getExportJournalTitle = (sourceMetadata: unknown) => {
  return getArticleSourceMetadataValue(sourceMetadata)?.journalTitle ?? ''
}

const buildPromptMetadataLines = (
  promptType: string,
  promptContent: string,
  includePromptType: boolean,
  includePromptContent: boolean,
) => {
  return [
    includePromptType ? `Type: ${promptType}` : '',
    includePromptContent ? `Content: ${promptContent}` : '',
  ].filter(Boolean)
}

const buildPromptHeaderLabel = (
  heading: string,
  promptType: string,
  promptContent: string,
  includePromptType: boolean,
  includePromptContent: boolean,
) => {
  const metadataLines = buildPromptMetadataLines(promptType, promptContent, includePromptType, includePromptContent)

  return (metadataLines.length > 0 ? [heading, ...metadataLines] : [heading]).join('\n')
}

const getProjectReviewConfig = async (projectId: string) => {
  const [project] = await appDatabaseService.queryJson<{
    modelId: string | null
    useAbstract: boolean
    useFulltext: boolean
    useFulltextNoImages: boolean
    useTitle: boolean
  }>(`
    SELECT
      model_id AS modelId,
      use_title AS useTitle,
      use_abstract AS useAbstract,
      use_fulltext AS useFulltext,
      use_fulltext_no_images AS useFulltextNoImages
    FROM app.project
    WHERE id = ${getSqlLiteral(projectId)}
    LIMIT 1
  `)

  return project ?? null
}

const getExportJob = async (projectId: string, jobId: string) => {
  const [job] = await appDatabaseService.queryJson<ExportJobRow>(`
    SELECT
      criteria_json AS criteriaJson,
      result_manifest_json AS resultManifestJson,
      review_config_hash AS reviewConfigHash,
      status
    FROM app.review_bulk_operation_job
    WHERE job_id = ${getSqlLiteral(jobId)}
      AND project_id = ${getSqlLiteral(projectId)}
      AND job_kind = 'review.export.selection'
    LIMIT 1
  `)

  return job ?? null
}

const escapeCSV = (value: string): string => {
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`
  }

  return value
}

const buildPromptInfoRows = (promptIds: string[], promptDetails: PromptDetails[]): PromptInfoRow[] => {
  const promptDetailsMap = new Map(
    promptDetails.map((detail) => {
      return [detail.id, detail]
    }),
  )

  return promptIds.flatMap((promptId) => {
    const detail = promptDetailsMap.get(promptId)

    return detail
      ? [{prompt: detail.originalText ?? '', title: detail.promptHeading || 'Untitled Prompt', type: detail.type ?? ''}]
      : []
  })
}

const buildPromptInfoCsv = (promptIds: string[], promptDetails: PromptDetails[]): string => {
  const rows = buildPromptInfoRows(promptIds, promptDetails)
  const headerRow = ['Prompt Heading', 'Prompt Answer Options', 'Prompt'].map(escapeCSV).join(',')
  const dataRows = rows.map((row) => {
    return [row.title, row.type, row.prompt].map(escapeCSV).join(',')
  })

  return [headerRow, ...dataRows].join('\n') + '\n'
}

const getPromptDetails = async (promptIds: string[]) => {
  return promptIds.length === 0
    ? []
    : appDatabaseService.queryJson<PromptDetails>(`
        SELECT
          id,
          prompt_heading AS promptHeading,
          original_text AS originalText,
          type
        FROM app.prompt
        WHERE id IN (${getQuotedStringList(promptIds).join(', ')})
      `)
}

const getExportHeaders = (input: {
  contract: ExportContract
  orderedPromptDetails: PromptDetails[]
  selectedMetadata: Record<string, boolean | undefined>
}) => {
  const promptOutput = input.contract.promptOutput ?? {}
  const headers = ['Title']

  if (input.selectedMetadata.includeArticleId) headers.push('Article ID')
  if (input.selectedMetadata.includeArticleLink) headers.push('Article Link')
  if (input.selectedMetadata.includeArticleAuthors) headers.push('Article Authors')
  if (input.selectedMetadata.includeSummary) headers.push('Abstract/Summary')
  if (input.selectedMetadata.includeJournal) headers.push('Journal')
  if (input.selectedMetadata.includeArticleCreatedAt) headers.push('Article Created At')
  if (input.selectedMetadata.includeArticleUpdatedAt) headers.push('Article Updated At')

  input.orderedPromptDetails.forEach((prompt) => {
    const baseHeading = prompt.promptHeading || (prompt.originalText ?? '').substring(0, 50) || prompt.id
    const heading = buildPromptHeaderLabel(
      baseHeading,
      prompt.type ?? '',
      prompt.originalText ?? '',
      promptOutput.includePromptType ?? false,
      promptOutput.includePromptContent ?? false,
    )
    headers.push(heading)
    if (promptOutput.includeExplanation) headers.push(`${baseHeading} - Explanation`)
    if (promptOutput.includeQuotes) headers.push(`${baseHeading} - Quotes`)
  })

  return headers
}

const getExportArticles = async (articleIds: string[], selectedMetadata: Record<string, boolean | undefined>) => {
  return appDatabaseService.queryJson<ExportArticleRow>(`
    SELECT
      a.id AS articleId,
      a.arxiv_id AS arxivId,
      a.biorxiv_id AS biorxivId,
      a.doi AS doi,
      a.medrxiv_id AS medrxivId,
      a.pubmed_id AS pubmedId,
      a.url AS articleUrl,
      a.article_title AS articleTitle,
      a.article_summary AS articleSummary,
      TO_JSON(a.article_authors) AS articleAuthors,
      a.article_created_at AS articleCreatedAt,
      a.article_updated_at AS articleUpdatedAt,
      ${selectedMetadata.includeArticleLink ? 'TO_JSON(a.original_data)' : 'NULL'} AS articleOriginalData,
      ${selectedMetadata.includeJournal || selectedMetadata.includeArticleLink ? 'TO_JSON(a.source_metadata)' : 'NULL'} AS articleSourceMetadata
    FROM app.article a
    WHERE a.id IN (${getQuotedStringList(articleIds).join(', ')})
    ORDER BY a.id ASC
  `)
}

const getExportJudgments = async (input: {
  articleIds: string[]
  promptIds: string[]
  projectConfig: NonNullable<Awaited<ReturnType<typeof getProjectReviewConfig>>>
}) => {
  return input.promptIds.length === 0
    ? []
    : appDatabaseService.queryJson<ExportJudgmentRow>(`
        SELECT
          j.article_id AS articleId,
          j.prompt_id AS promptId,
          j.answered_original AS answeredOriginal,
          TO_JSON(j.answered_original_as_array) AS answeredOriginalAsArray,
          j.explanation AS explanation,
          TO_JSON(j.quotes) AS quotes
        FROM app.judgment j
        WHERE ${getAndClause([
          `j.article_id IN (${getQuotedStringList(input.articleIds).join(', ')})`,
          `j.prompt_id IN (${getQuotedStringList(input.promptIds).join(', ')})`,
          'j.deleted_at IS NULL',
          getJudgmentConfigClause({configs: [input.projectConfig], judgmentAlias: 'j'}),
        ])}
      `)
}

const getAnswerValue = (row: ExportJudgmentRow) => {
  const parsedAnswerArray = getJsonValue(row.answeredOriginalAsArray)

  return Array.isArray(parsedAnswerArray) && parsedAnswerArray.length > 0
    ? getStringArray(parsedAnswerArray).join('; ')
    : (row.answeredOriginal ?? '')
}

const getQuotesValue = (value: unknown) => {
  const quotesValue = getJsonValue(value)

  return Array.isArray(quotesValue)
    ? quotesValue
        .map((quote) => {
          return typeof quote === 'string' ? quote : JSON.stringify(quote)
        })
        .join('; ')
    : typeof quotesValue === 'string'
      ? quotesValue
      : quotesValue === null || quotesValue === undefined
        ? ''
        : JSON.stringify(quotesValue)
}

const buildExportCsvRows = (input: {
  articles: ExportArticleRow[]
  judgments: ExportJudgmentRow[]
  orderedPromptIds: string[]
  promptOutput: NonNullable<ExportContract['promptOutput']>
  selectedMetadata: Record<string, boolean | undefined>
}) => {
  const judgmentsByArticleAndPrompt = new Map(
    input.judgments.map((judgment) => {
      return [`${judgment.articleId}:${judgment.promptId}`, judgment]
    }),
  )

  return input.articles.map((article) => {
    const sourceMetadata = getJsonValue(article.articleSourceMetadata)
    const originalData = getJsonValue(article.articleOriginalData)
    const articleAuthors = getJsonValue(article.articleAuthors)
    const row = [article.articleTitle || 'Untitled']

    if (input.selectedMetadata.includeArticleId) row.push(article.articleId)
    if (input.selectedMetadata.includeArticleLink) {
      row.push(
        getArticleUrl({
          arxivId: article.arxivId,
          biorxivId: article.biorxivId,
          doi: article.doi,
          medrxivId: article.medrxivId,
          originalData,
          pubmedId: article.pubmedId,
          sourceMetadata,
          url: article.articleUrl,
        }),
      )
    }
    if (input.selectedMetadata.includeArticleAuthors) row.push(getStringArray(articleAuthors).join('; '))
    if (input.selectedMetadata.includeSummary) row.push(article.articleSummary || '')
    if (input.selectedMetadata.includeJournal) row.push(getExportJournalTitle(sourceMetadata))
    if (input.selectedMetadata.includeArticleCreatedAt) row.push(formatArticleDate(article.articleCreatedAt))
    if (input.selectedMetadata.includeArticleUpdatedAt) row.push(formatArticleDate(article.articleUpdatedAt))

    input.orderedPromptIds.forEach((promptId) => {
      const judgment = judgmentsByArticleAndPrompt.get(`${article.articleId}:${promptId}`)
      row.push(judgment ? getAnswerValue(judgment) : '')
      if (input.promptOutput.includeExplanation) row.push(judgment?.explanation ?? '')
      if (input.promptOutput.includeQuotes) row.push(judgment ? getQuotesValue(judgment.quotes) : '')
    })

    return row.map(escapeCSV).join(',')
  })
}

const buildExportCsv = async (input: {articleIds: string[]; contract: ExportContract; projectId: string}) => {
  const promptOutput = input.contract.promptOutput ?? {}
  const selectedMetadata = input.contract.selectedMetadata ?? {}
  const promptIds = promptOutput.promptIds ?? []
  const promptDetails = await getPromptDetails(promptIds)
  const promptDetailsById = new Map(
    promptDetails.map((prompt) => {
      return [prompt.id, prompt]
    }),
  )
  const orderedPromptDetails = promptIds.flatMap((promptId) => {
    const prompt = promptDetailsById.get(promptId)

    return prompt ? [prompt] : []
  })
  const projectConfig = await getProjectReviewConfig(input.projectId)
  const batches = Array.from({length: Math.ceil(input.articleIds.length / exportBatchSize)}, (_, index) => {
    return input.articleIds.slice(index * exportBatchSize, (index + 1) * exportBatchSize)
  })
  const batchRows = await batches.reduce<Promise<string[]>>(async (rowsPromise, articleIds) => {
    const rows = await rowsPromise
    const [articles, judgments] = await Promise.all([
      getExportArticles(articleIds, selectedMetadata),
      projectConfig
        ? getExportJudgments({articleIds, projectConfig, promptIds})
        : Promise.resolve([] as ExportJudgmentRow[]),
    ])

    const batchCsvRows = buildExportCsvRows({
      articles,
      judgments,
      orderedPromptIds: orderedPromptDetails.map((prompt) => {
        return prompt.id
      }),
      promptOutput,
      selectedMetadata,
    })

    return [...rows, ...batchCsvRows]
  }, Promise.resolve([]))
  const headerRow = getExportHeaders({contract: input.contract, orderedPromptDetails, selectedMetadata})
    .map(escapeCSV)
    .join(',')

  return [headerRow, ...batchRows.flat()].join('\n') + '\n'
}

const getProject = async (projectId: string) => {
  const [project] = await appDatabaseService.queryJson<{id: string; name: string}>(`
    SELECT id, name
    FROM app.project
    WHERE id = ${getSqlLiteral(projectId)}
    LIMIT 1
  `)

  return project ?? null
}

const getSharedReviewConfigHash = async (sourceProjectIds: string[]) => {
  const hashes = await Promise.all(
    sourceProjectIds.map((sourceProjectId) => {
      return getCurrentReviewConfigHash(sourceProjectId)
    }),
  )
  const uniqueHashes = [...new Set(hashes)]

  return uniqueHashes.length === 1 ? uniqueHashes[0] : null
}

const getExportPromptFilters = (promptSelections: Array<{promptId: string; types: string[]}>) => {
  return promptSelections.reduce<Record<string, string[]>>((filters, selection) => {
    return selection.types.length > 0 ? {...filters, [selection.promptId]: selection.types} : filters
  }, {})
}

export const projectExportRoutes = new Elysia()
  .use(withErrorHandler())
  .post(
    '/api/projects/:id/export',
    async ({params, body, set}) => {
      const projectId = params.id
      const sourceProjectIds = body.sourceProjectIds ?? [projectId]

      await Promise.all(
        sourceProjectIds.map((sourceProjectId) => {
          return assertProjectIsActive(sourceProjectId)
        }),
      )

      const project = await getProject(projectId)

      if (!project) {
        throw new Error('Project not found')
      }

      const promptSelections = body.promptSelections ?? []
      const prompts = getExportPromptFilters(promptSelections)
      const selectedMetadata = {
        includeArticleAuthors: body.includeArticleAuthors ?? false,
        includeArticleCreatedAt: body.includeArticleCreatedAt ?? false,
        includeArticleId: body.includeArticleId ?? false,
        includeArticleLink: body.includeArticleLink ?? false,
        includeArticleUpdatedAt: body.includeArticleUpdatedAt ?? false,
        includeJournal: body.includeJournal ?? false,
        includeSummary: body.includeSummary ?? false,
      }
      const promptOutput = {
        includeExplanation: body.includeExplanation ?? false,
        includePromptContent: body.includePromptContent ?? false,
        includePromptType: body.includePromptType ?? false,
        includeQuotes: body.includeQuotes ?? false,
        promptIds: body.promptIds,
        promptSelections,
      }
      const snapshot = body.snapshotId
        ? {expiresAt: body.snapshotPinExpiresAt, snapshotId: body.snapshotId, type: 'pinned' as const}
        : {type: 'latest' as const}
      const sourceProjectId = sourceProjectIds[0] ?? projectId
      const reviewConfigHash = await getSharedReviewConfigHash(sourceProjectIds)

      if (sourceProjectIds.length > 1 && reviewConfigHash === null) {
        set.status = 400
        return {error: 'Export sources must use the same review configuration', success: false}
      }

      const job = await createReviewBulkOperationJob({
        batchSize: exportBatchSize,
        criteria: {
          articleIds: body.articleIds,
          exportContract: {
            payloadBudgetBytes: exportPayloadBudgetBytes,
            promptOutput,
            projectionIdentity: 'review.export.selection',
            selectedMetadata,
            snapshotCursor: {mode: 'keyset', orderBy: ['article_id']},
          },
          listType: body.listType ?? 'llm',
          operation: 'export',
          prompts,
          requestId: randomUUID(),
          search: body.search,
          sourceProjectId,
          sourceProjectIds,
        },
        filters: {listType: body.listType ?? 'llm', prompts, search: body.search},
        jobKind: 'review.export.selection',
        projectId,
        reviewConfigHash,
        searchMode: body.search ? 'substring' : 'none',
        searchText: body.search,
        snapshot,
      })

      projectExportLogger.force('project.export.job-created', 'Project export job created', 'log', {
        articleIdCount: body.articleIds?.length ?? null,
        jobId: job.jobId,
        listType: body.listType ?? 'llm',
        projectId,
        promptCount: body.promptIds.length,
        promptFilterCount: promptSelections.length,
        sourceProjectIds,
      })

      set.status = 202

      return {
        downloadUrl: `/api/projects/${projectId}/export/${job.jobId}/download`,
        exportContract: {payloadBudgetBytes: exportPayloadBudgetBytes, promptOutput, selectedMetadata},
        job,
        success: true,
      }
    },
    {
      body: t.Object({
        promptIds: t.Array(t.String()),
        promptSelections: t.Optional(t.Array(t.Object({promptId: t.String(), types: t.Array(t.String())}))),
        sourceProjectIds: t.Optional(t.Array(t.String())),
        articleIds: t.Optional(t.Array(t.String())),
        listType: t.Optional(
          t.Union([t.Literal('llm'), t.Literal('human'), t.Literal('both'), t.Literal('unassessed')]),
        ),
        search: t.Optional(t.String()),
        snapshotId: t.Optional(t.String()),
        snapshotPinExpiresAt: t.Optional(t.String()),
        includeExplanation: t.Optional(t.Boolean()),
        includeQuotes: t.Optional(t.Boolean()),
        includeJournal: t.Optional(t.Boolean()),
        includeSummary: t.Optional(t.Boolean()),
        includeArticleId: t.Optional(t.Boolean()),
        includeArticleLink: t.Optional(t.Boolean()),
        includeArticleAuthors: t.Optional(t.Boolean()),
        includeArticleCreatedAt: t.Optional(t.Boolean()),
        includeArticleUpdatedAt: t.Optional(t.Boolean()),
        includePromptType: t.Optional(t.Boolean()),
        includePromptContent: t.Optional(t.Boolean()),
      }),
    },
  )
  .get(
    '/api/projects/:id/export/:jobId/download',
    async ({params, set}) => {
      await assertProjectIsActive(params.id)

      const [project, job] = await Promise.all([getProject(params.id), getExportJob(params.id, params.jobId)])

      if (!project || !job) {
        set.status = 404
        return {error: 'Export job not found', success: false}
      }

      if (job.status !== 'completed') {
        set.status = 409
        return {error: 'Export job is not completed yet', status: job.status, success: false}
      }

      const articleIds = getExportArticleIds(job.resultManifestJson)
      const csv = await buildExportCsv({
        articleIds,
        contract: getExportContract(job.criteriaJson),
        projectId: params.id,
      })
      const filename = `${project.name.replace(/[^a-zA-Z0-9]/g, '_')}_export_${new Date().toISOString().slice(0, 10)}.csv`

      set.headers['Content-Type'] = 'text/csv; charset=utf-8'
      set.headers['Content-Disposition'] = `attachment; filename="${filename}"`

      return new Response(csv, {
        headers: {
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Content-Type': 'text/csv; charset=utf-8',
        },
      })
    },
    {params: t.Object({id: t.String(), jobId: t.String()})},
  )
  .post(
    '/api/projects/:id/export-prompts',
    async ({params, body, set}) => {
      await assertProjectIsActive(params.id)

      const project = await getProject(params.id)

      if (!project) {
        throw new Error('Project not found')
      }

      if (body.promptIds.length === 0) {
        set.status = 400
        return {data: null, error: 'No prompts selected for export'}
      }

      const promptDetails = await appDatabaseService.queryJson<PromptDetails>(`
        SELECT
          id,
          prompt_heading AS promptHeading,
          original_text AS originalText,
          type
        FROM app.prompt
        WHERE id IN (${getQuotedStringList(body.promptIds).join(', ')})
      `)
      const csv = buildPromptInfoCsv(body.promptIds, promptDetails)
      const filename = `${project.name.replace(/[^a-zA-Z0-9]/g, '_')}_prompts_${new Date().toISOString().slice(0, 10)}.csv`

      set.headers['Content-Type'] = 'text/csv; charset=utf-8'
      set.headers['Content-Disposition'] = `attachment; filename="${filename}"`

      return new Response(csv, {
        headers: {
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Content-Type': 'text/csv; charset=utf-8',
        },
      })
    },
    {body: t.Object({promptIds: t.Array(t.String())})},
  )
