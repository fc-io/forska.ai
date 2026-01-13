import {and, eq, inArray, isNull, or, sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {
  articleRouteLink,
  articles,
  judgments,
  projectArticles,
  projectRouteLink,
  projects,
  prompts,
} from '../../db/schema.ts'
import {getJournalTitleFromOriginalData} from '../../utils/getJournalTitleFromOriginalData.ts'
import {requireUserAuth} from '../utils/authGuard.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {withErrorHandler} from '../utils/routeErrorHandler.ts'

const BATCH_SIZE = 500

// Escape CSV field
const escapeCSV = (value: string): string => {
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

type PromptDetails = {id: string; promptHeading: string | null; originalText: string | null; type: string | null}

type PromptInfoRow = {title: string; type: string; prompt: string}

type ArticleUrlStrategy = {isMatch: (articleId: string) => boolean; buildUrl: (articleId: string) => string}

const articleUrlStrategies: ArticleUrlStrategy[] = [
  {
    isMatch: (articleId) => {
      return articleId.startsWith('oai:arXiv.org:')
    },
    buildUrl: (articleId) => {
      return `https://www.arxiv.org/abs/${articleId.slice(14)}`
    },
  },
  {
    isMatch: (articleId) => {
      return articleId.startsWith('pmid:')
    },
    buildUrl: (articleId) => {
      return `https://pubmed.ncbi.nlm.nih.gov/${articleId.slice(5)}/`
    },
  },
  {
    isMatch: (articleId) => {
      return articleId.startsWith('medRxiv:')
    },
    buildUrl: (articleId) => {
      return `https://www.medrxiv.org/content/${articleId.slice(8)}`
    },
  },
  {
    isMatch: (articleId) => {
      return articleId.startsWith('bioRxiv:')
    },
    buildUrl: (articleId) => {
      return `https://www.biorxiv.org/content/${articleId.slice(8)}`
    },
  },
]

const getArticleUrl = (articleId: string | null): string => {
  const articleIdValue = articleId ?? ''
  const matchingStrategy = articleUrlStrategies.find((strategy) => {
    return strategy.isMatch(articleIdValue)
  })
  return matchingStrategy ? matchingStrategy.buildUrl(articleIdValue) : ''
}

const formatArticleDate = (value: Date | string | null | undefined): string => {
  const dateValue = value ? (typeof value === 'string' ? new Date(value) : value) : null
  return dateValue ? dateValue.toISOString() : ''
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
      ? [{title: detail.promptHeading || 'Untitled Prompt', type: detail.type ?? '', prompt: detail.originalText ?? ''}]
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

const buildPromptMetadataLines = (
  promptType: string,
  promptContent: string,
  includePromptType: boolean,
  includePromptContent: boolean,
): string[] => {
  const typeLine = includePromptType ? `Type: ${promptType}` : ''
  const contentLine = includePromptContent ? `Content: ${promptContent}` : ''
  return [typeLine, contentLine].filter(Boolean)
}

const buildPromptHeaderLabel = (
  heading: string,
  promptType: string,
  promptContent: string,
  includePromptType: boolean,
  includePromptContent: boolean,
): string => {
  const metadataLines = buildPromptMetadataLines(promptType, promptContent, includePromptType, includePromptContent)
  const labelLines = metadataLines.length > 0 ? [heading, ...metadataLines] : [heading]
  return labelLines.join('\n')
}

export const projectExportRoutes = new Elysia()
  .use(withErrorHandler())
  .use(requireUserAuth())
  .post(
    '/api/projects/:id/export',
    async ({params, body, set}) => {
      const db = getDatabase()
      const projectId = params.id
      const includeExplanation = body.includeExplanation ?? false
      const includeQuotes = body.includeQuotes ?? false
      const includeJournal = body.includeJournal ?? false
      const includeSummary = body.includeSummary ?? false
      const includeArticleId = body.includeArticleId ?? false
      const includeArticleLink = body.includeArticleLink ?? false
      const includeArticleAuthors = body.includeArticleAuthors ?? false
      const includeArticleCreatedAt = body.includeArticleCreatedAt ?? false
      const includeArticleUpdatedAt = body.includeArticleUpdatedAt ?? false
      const includePromptType = body.includePromptType ?? false
      const includePromptContent = body.includePromptContent ?? false

      // Verify project exists
      const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
      if (!project) {
        throw new Error('Project not found')
      }

      const promptIds = body.promptIds
      if (!promptIds || promptIds.length === 0) {
        throw new Error('No prompts selected for export')
      }

      // Get prompt details for headers
      const promptDetails = await db
        .select({
          id: prompts.id,
          promptHeading: prompts.promptHeading,
          originalText: prompts.originalText,
          type: prompts.type,
        })
        .from(prompts)
        .where(inArray(prompts.id, promptIds))

      const promptHeaderMap = new Map<string, string>()
      const promptTypeMap = new Map<string, string>()
      const promptContentMap = new Map<string, string>()
      for (const p of promptDetails) {
        promptHeaderMap.set(p.id, p.promptHeading || p.originalText.substring(0, 50))
        promptTypeMap.set(p.id, p.type ?? '')
        promptContentMap.set(p.id, p.originalText ?? '')
      }

      // Build scope condition for articles
      const sourceProjectIds = body.sourceProjectIds || [projectId]

      // Get project model and content settings for filtering judgments
      const projectSettings = await db
        .select({
          id: projects.id,
          modelId: projects.modelId,
          useTitle: projects.useTitle,
          useAbstract: projects.useAbstract,
          useFulltext: projects.useFulltext,
          useFulltextNoImages: projects.useFulltextNoImages,
        })
        .from(projects)
        .where(inArray(projects.id, sourceProjectIds))

      // Build judgment filter: must match model+content from at least one source project
      const judgmentConfigParts = projectSettings.map((proj) => {
        return and(
          eq(judgments.modelId, proj.modelId),
          eq(judgments.useTitle, proj.useTitle),
          eq(judgments.useAbstract, proj.useAbstract),
          eq(judgments.useFulltext, proj.useFulltext),
          eq(judgments.useFulltextNoImages, proj.useFulltextNoImages),
        )
      })
      const judgmentConfigCondition =
        judgmentConfigParts.length > 1 ? or(...judgmentConfigParts) : judgmentConfigParts[0]

      const projectImportRoutes = await db
        .select({projectId: projectRouteLink.projectId, importRouteId: projectRouteLink.importRouteId})
        .from(projectRouteLink)
        .where(inArray(projectRouteLink.projectId, sourceProjectIds))

      const allImportRouteIds = projectImportRoutes.map((r) => {
        return r.importRouteId
      })

      const scopeParts: Array<ReturnType<typeof sql>> = []

      if (allImportRouteIds.length > 0) {
        const routeIdArray = sql.join(
          allImportRouteIds.map((r) => {
            return sql`${r}::uuid`
          }),
          sql`,`,
        )
        scopeParts.push(
          sql`EXISTS (
            SELECT 1 FROM ${articleRouteLink} arl
            WHERE arl."article_id" = ${articles.id}
              AND arl."import_route_id" = ANY(ARRAY[${routeIdArray}])
          )`,
        )
      }

      for (const sourceProjectId of sourceProjectIds) {
        scopeParts.push(
          sql`EXISTS (
            SELECT 1 FROM ${projectArticles} pa
            WHERE pa."article_id" = ${articles.id}
              AND pa."project_id" = ${sourceProjectId}::uuid
          )`,
        )
      }

      const scopeCondition = scopeParts.length > 1 ? or(...scopeParts) : scopeParts[0]

      // Build CSV header
      const orderedPromptIds = promptIds.filter((id) => {
        return promptHeaderMap.has(id)
      })

      const headers: string[] = ['Title']
      if (includeArticleId) {
        headers.push('Article ID')
      }
      if (includeArticleLink) {
        headers.push('Article Link')
      }
      if (includeArticleAuthors) {
        headers.push('Article Authors')
      }
      if (includeSummary) {
        headers.push('Abstract/Summary')
      }
      if (includeJournal) {
        headers.push('Journal')
      }
      if (includeArticleCreatedAt) {
        headers.push('Article Created At')
      }
      if (includeArticleUpdatedAt) {
        headers.push('Article Updated At')
      }
      for (const id of orderedPromptIds) {
        const baseHeading = promptHeaderMap.get(id) || id
        const heading = buildPromptHeaderLabel(
          baseHeading,
          promptTypeMap.get(id) ?? '',
          promptContentMap.get(id) ?? '',
          includePromptType,
          includePromptContent,
        )
        headers.push(heading)
        if (includeExplanation) {
          headers.push(`${baseHeading} - Explanation`)
        }
        if (includeQuotes) {
          headers.push(`${baseHeading} - Quotes`)
        }
      }

      const filename = `${project.name.replace(/[^a-zA-Z0-9]/g, '_')}_export_${new Date().toISOString().slice(0, 10)}.csv`

      // Set response headers for streaming CSV download
      set.headers['Content-Type'] = 'text/csv; charset=utf-8'
      set.headers['Content-Disposition'] = `attachment; filename="${filename}"`

      // Create a streaming response using ReadableStream
      const stream = new ReadableStream({
        async start(controller) {
          try {
            // Send header row
            controller.enqueue(headers.map(escapeCSV).join(',') + '\n')

            // Get article count first with a lightweight query
            const countResult = await db
              .select({count: sql<number>`count(DISTINCT ${articles.id})`})
              .from(articles)
              .innerJoin(
                judgments,
                and(
                  eq(judgments.articleId, articles.id),
                  inArray(judgments.promptId, promptIds),
                  isNull(judgments.deletedAt),
                  judgmentConfigCondition,
                ),
              )
              .where(scopeCondition)

            const totalCount = Number(countResult[0]?.count ?? 0)
            console.log(`[export] Starting export of ~${totalCount} articles`)

            let offset = 0
            let processedCount = 0

            while (true) {
              // Fetch batch of articles with their judgments using OFFSET/LIMIT
              const batchData = await db
                .select({
                  articleId: articles.id,
                  articleExternalId: articles.articleId,
                  articleTitle: articles.articleTitle,
                  articleSummary: articles.articleSummary,
                  articleAuthors: articles.articleAuthors,
                  articleCreatedAt: articles.articleCreatedAt,
                  articleUpdatedAt: articles.articleUpdatedAt,
                  articleOriginalData: includeJournal ? articles.originalData : sql<null>`NULL`,
                  promptId: judgments.promptId,
                  answeredOriginal: judgments.answeredOriginal,
                  answeredOriginalAsArray: judgments.answeredOriginalAsArray,
                  explanation: judgments.explanation,
                  quotes: judgments.quotes,
                })
                .from(articles)
                .innerJoin(
                  judgments,
                  and(
                    eq(judgments.articleId, articles.id),
                    inArray(judgments.promptId, promptIds),
                    isNull(judgments.deletedAt),
                    judgmentConfigCondition,
                  ),
                )
                .where(scopeCondition)
                .orderBy(articles.id)
                .limit(BATCH_SIZE * promptIds.length) // Account for multiple rows per article
                .offset(offset)

              if (batchData.length === 0) {
                break
              }

              // Group batch data by article
              const batchArticleMap = new Map<
                string,
                {
                  title: string
                  articleId: string
                  articleUrl: string
                  authors: string
                  createdAt: string
                  updatedAt: string
                  summary: string
                  journalTitle: string
                  answers: Map<string, string>
                  explanations: Map<string, string>
                  quotes: Map<string, string>
                }
              >()

              for (const row of batchData) {
                if (!batchArticleMap.has(row.articleId)) {
                  const articleExternalId = row.articleExternalId ?? ''
                  const articleUrl = includeArticleLink ? getArticleUrl(articleExternalId) : ''
                  const articleAuthors = includeArticleAuthors ? (row.articleAuthors?.join('; ') ?? '') : ''
                  const articleCreatedAt = includeArticleCreatedAt ? formatArticleDate(row.articleCreatedAt) : ''
                  const articleUpdatedAt = includeArticleUpdatedAt ? formatArticleDate(row.articleUpdatedAt) : ''
                  const journalTitle = includeJournal
                    ? (getJournalTitleFromOriginalData(row.articleOriginalData) ?? '')
                    : ''
                  batchArticleMap.set(row.articleId, {
                    title: row.articleTitle || 'Untitled',
                    articleId: articleExternalId,
                    articleUrl,
                    authors: articleAuthors,
                    createdAt: articleCreatedAt,
                    updatedAt: articleUpdatedAt,
                    summary: row.articleSummary || '',
                    journalTitle,
                    answers: new Map(),
                    explanations: new Map(),
                    quotes: new Map(),
                  })
                }
                const article = batchArticleMap.get(row.articleId)
                if (article) {
                  let answer = row.answeredOriginal || ''
                  if (row.answeredOriginalAsArray && row.answeredOriginalAsArray.length > 0) {
                    answer = row.answeredOriginalAsArray.join('; ')
                  }
                  article.answers.set(row.promptId, answer)

                  if (includeExplanation && row.explanation) {
                    article.explanations.set(row.promptId, row.explanation)
                  }

                  if (includeQuotes && row.quotes) {
                    const quotesValue = row.quotes
                    if (Array.isArray(quotesValue)) {
                      article.quotes.set(row.promptId, quotesValue.join('; '))
                    } else if (typeof quotesValue === 'string') {
                      article.quotes.set(row.promptId, quotesValue)
                    } else {
                      article.quotes.set(row.promptId, JSON.stringify(quotesValue))
                    }
                  }
                }
              }

              // Stream CSV rows for this batch
              for (const [_, articleData] of batchArticleMap) {
                const row: string[] = [articleData.title]
                if (includeArticleId) {
                  row.push(articleData.articleId)
                }
                if (includeArticleLink) {
                  row.push(articleData.articleUrl)
                }
                if (includeArticleAuthors) {
                  row.push(articleData.authors)
                }
                if (includeSummary) {
                  row.push(articleData.summary)
                }
                if (includeJournal) {
                  row.push(articleData.journalTitle)
                }
                if (includeArticleCreatedAt) {
                  row.push(articleData.createdAt)
                }
                if (includeArticleUpdatedAt) {
                  row.push(articleData.updatedAt)
                }
                for (const promptId of orderedPromptIds) {
                  row.push(articleData.answers.get(promptId) || '')
                  if (includeExplanation) {
                    row.push(articleData.explanations.get(promptId) || '')
                  }
                  if (includeQuotes) {
                    row.push(articleData.quotes.get(promptId) || '')
                  }
                }
                controller.enqueue(row.map(escapeCSV).join(',') + '\n')
                processedCount++
              }

              offset += batchData.length
              console.log(`[export] Streamed ${processedCount} articles`)

              // Check if we got fewer rows than expected (end of data)
              if (batchData.length < BATCH_SIZE * promptIds.length) {
                break
              }
            }

            console.log(`[export] Export complete: ${processedCount} articles`)
            controller.close()
          } catch (err) {
            console.error('[export] Error:', err)
            controller.error(err)
          }
        },
      })

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
      })
    },
    {
      body: t.Object({
        promptIds: t.Array(t.String()),
        sourceProjectIds: t.Optional(t.Array(t.String())),
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
      const db = getDatabase()
      const projectId = params.id

      const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
      if (!project) {
        throw new Error('Project not found')
      }

      const promptIds = body.promptIds
      if (!promptIds || promptIds.length === 0) {
        throw new Error('No prompts selected for export')
      }

      const promptDetails = await db
        .select({
          id: prompts.id,
          promptHeading: prompts.promptHeading,
          originalText: prompts.originalText,
          type: prompts.type,
        })
        .from(prompts)
        .where(inArray(prompts.id, promptIds))

      const csv = buildPromptInfoCsv(promptIds, promptDetails)
      const filename = `${project.name.replace(/[^a-zA-Z0-9]/g, '_')}_prompts_${new Date().toISOString().slice(0, 10)}.csv`

      set.headers['Content-Type'] = 'text/csv; charset=utf-8'
      set.headers['Content-Disposition'] = `attachment; filename="${filename}"`

      return new Response(csv, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
      })
    },
    {body: t.Object({promptIds: t.Array(t.String())})},
  )
