import {randomUUID} from 'node:crypto'

import {Elysia, t} from 'elysia'

import {createReviewBulkOperationJob} from '../reviewServing/reviewBulkOperationService.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getQuotedStringList, getSqlLiteral} from '../services/appQueryHelpers.ts'
import {getCurrentReviewConfigHash} from '../services/reviewServingProjectConfigIdentity.ts'
import {createRateLimitedLogger} from '../utils/rateLimitedLogger.ts'
import {withErrorHandler} from '../utils/routeErrorHandler.ts'
import {assertProjectIsActive} from './projectsRoutes/projectAccessGuard.ts'

type PromptDetails = {id: string; promptHeading: string | null; originalText: string | null; type: string | null}
type PromptInfoRow = {prompt: string; title: string; type: string}

const appDatabaseService = getAppDatabaseService()
const projectExportLogger = createRateLimitedLogger({sink: 'file-only', windowMs: 30_000})
const exportPayloadBudgetBytes = 10_000_000
const exportBatchSize = 500

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

const getProject = async (projectId: string) => {
  const [project] = await appDatabaseService.queryJson<{id: string; name: string}>(`
    SELECT id, name
    FROM app.project
    WHERE id = ${getSqlLiteral(projectId)}
    LIMIT 1
  `)

  return project ?? null
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
      const reviewConfigHash = await getCurrentReviewConfigHash(sourceProjectId)
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
        projectId: sourceProjectId,
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
