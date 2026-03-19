import {Elysia, t} from 'elysia'

import {getJournalTitleFromOriginalData} from '../../utils/getJournalTitleFromOriginalData.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import * as appQueryHelpers from '../services/appQueryHelpers.ts'
import {getAppQueryService} from '../services/getAppQueryService.ts'
import {hasMatchingJudgmentAnswer} from '../utils/judgmentAnswers.ts'
import {withErrorHandler} from '../utils/routeErrorHandler.ts'
import {assertProjectIsActive} from './projectsRoutes/projectAccessGuard.ts'

const BATCH_SIZE = 500

const parseArktypeOptions = (typeStr: string | null): string[] => {
  if (!typeStr) return []
  const matches = typeStr.match(/['"]([^'"]+)['"]/g)
  return (
    matches?.map((match) => {
      return match.slice(1, -1)
    }) ?? []
  )
}

const escapeCSV = (value: string): string => {
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

type PromptDetails = {id: string; promptHeading: string | null; originalText: string | null; type: string | null}
type PromptInfoRow = {title: string; type: string; prompt: string}
type ArticleUrlStrategy = {isMatch: (articleId: string) => boolean; buildUrl: (articleId: string) => string}
type SourceProjectSetting = {
  id: string
  modelId: string | null
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
}
type SourceProjectImportRoute = {projectId: string; importRouteId: string}
const appDatabaseService = getAppDatabaseService()
const appQueryService = getAppQueryService()
const {
  getAndClause,
  getDateValue,
  getJsonValue,
  getJudgmentConfigClause,
  getOrClause,
  getQuotedStringList,
  getSqlLiteral,
} = appQueryHelpers

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

const getSourceScopeClause = (sourceProjectIds: string[], importRouteIds: string[]) => {
  return getOrClause([
    importRouteIds.length > 0
      ? `EXISTS (
          SELECT 1
          FROM app.article_import_route air
          WHERE air.article_id = a.id
            AND air.import_route_id IN (${getQuotedStringList(importRouteIds).join(', ')})
        )`
      : null,
    ...sourceProjectIds.map((sourceProjectId) => {
      return `EXISTS (
        SELECT 1
        FROM app.project_article pa
        WHERE pa.article_id = a.id
          AND pa.project_id = ${getSqlLiteral(sourceProjectId)}
      )`
    }),
  ])
}

const getSingleSourceProjectScope = async (
  sourceProjectId: string,
  hasPrompts: boolean,
): Promise<{projectSettings: SourceProjectSetting[]; projectImportRoutes: SourceProjectImportRoute[]}> => {
  const projectConfig = await appQueryService.getProjectReviewConfig(sourceProjectId)

  return projectConfig
    ? {
        projectSettings: hasPrompts
          ? [
              {
                id: sourceProjectId,
                modelId: projectConfig.modelId,
                useTitle: projectConfig.useTitle,
                useAbstract: projectConfig.useAbstract,
                useFulltext: projectConfig.useFulltext,
                useFulltextNoImages: projectConfig.useFulltextNoImages,
              },
            ]
          : [],
        projectImportRoutes: projectConfig.importRouteIds.map((importRouteId) => {
          return {projectId: sourceProjectId, importRouteId}
        }),
      }
    : {projectSettings: [], projectImportRoutes: []}
}

const getMultipleSourceProjectScope = async (
  sourceProjectIds: string[],
  hasPrompts: boolean,
): Promise<{projectSettings: SourceProjectSetting[]; projectImportRoutes: SourceProjectImportRoute[]}> => {
  const [projectSettings, projectImportRoutes] = await Promise.all([
    hasPrompts
      ? appDatabaseService.queryJson<SourceProjectSetting>(`
          SELECT
            id,
            model_id AS modelId,
            use_title AS useTitle,
            use_abstract AS useAbstract,
            use_fulltext AS useFulltext,
            use_fulltext_no_images AS useFulltextNoImages
          FROM app.project
          WHERE id IN (${getQuotedStringList(sourceProjectIds).join(', ')})
        `)
      : Promise.resolve([]),
    appDatabaseService.queryJson<SourceProjectImportRoute>(`
      SELECT
        project_id AS projectId,
        import_route_id AS importRouteId
      FROM app.project_import_route
      WHERE project_id IN (${getQuotedStringList(sourceProjectIds).join(', ')})
    `),
  ])

  return {projectSettings, projectImportRoutes}
}

const getSourceProjectScope = async (
  sourceProjectIds: string[],
  hasPrompts: boolean,
): Promise<{projectSettings: SourceProjectSetting[]; projectImportRoutes: SourceProjectImportRoute[]}> => {
  const [singleSourceProjectId] = sourceProjectIds

  return sourceProjectIds.length === 1 && singleSourceProjectId
    ? getSingleSourceProjectScope(singleSourceProjectId, hasPrompts)
    : getMultipleSourceProjectScope(sourceProjectIds, hasPrompts)
}

export const projectExportRoutes = new Elysia()
  .use(withErrorHandler())
  .post(
    '/api/projects/:id/export',
    async ({params, body, set}) => {
      const projectId = params.id
      const sourceProjectIds = body.sourceProjectIds || [projectId]

      await Promise.all(
        sourceProjectIds.map((sourceProjectId) => {
          return assertProjectIsActive(sourceProjectId)
        }),
      )

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

      const [project] = await appDatabaseService.queryJson<{id: string; name: string}>(`
        SELECT id, name
        FROM app.project
        WHERE id = ${getSqlLiteral(projectId)}
        LIMIT 1
      `)
      if (!project) {
        throw new Error('Project not found')
      }

      const promptIds = body.promptIds ?? []
      const hasPrompts = promptIds.length > 0
      const promptSelections = body.promptSelections ?? []
      const hasPromptFilters = promptSelections.length > 0
      const promptHeaderMap = new Map<string, string>()
      const promptTypeMap = new Map<string, string>()
      const promptContentMap = new Map<string, string>()

      if (hasPrompts) {
        const promptDetails = await appDatabaseService.queryJson<PromptDetails>(`
          SELECT
            id,
            prompt_heading AS promptHeading,
            original_text AS originalText,
            type
          FROM app.prompt
          WHERE id IN (${getQuotedStringList(promptIds).join(', ')})
        `)

        for (const prompt of promptDetails) {
          promptHeaderMap.set(prompt.id, prompt.promptHeading || (prompt.originalText ?? '').substring(0, 50))
          promptTypeMap.set(prompt.id, prompt.type ?? '')
          promptContentMap.set(prompt.id, prompt.originalText ?? '')
        }
      }

      const {projectSettings, projectImportRoutes} = await getSourceProjectScope(sourceProjectIds, hasPrompts)
      const judgmentConfigCondition = hasPrompts
        ? getJudgmentConfigClause({
            judgmentAlias: 'j',
            configs: projectSettings.map((projectSetting) => {
              return {
                modelId: projectSetting.modelId,
                useTitle: projectSetting.useTitle,
                useAbstract: projectSetting.useAbstract,
                useFulltext: projectSetting.useFulltext,
                useFulltextNoImages: projectSetting.useFulltextNoImages,
              }
            }),
          })
        : null
      const allImportRouteIds = projectImportRoutes.map((row) => {
        return row.importRouteId
      })
      const scopeCondition = getSourceScopeClause(sourceProjectIds, allImportRouteIds) ?? 'FALSE'

      let filteredArticleIds: string[] | null = null
      if (hasPromptFilters && hasPrompts && judgmentConfigCondition) {
        const effectivePromptSelections = promptSelections.filter((filter) => {
          const promptType = promptTypeMap.get(filter.promptId)
          const allOptions = parseArktypeOptions(promptType ?? null)
          if (allOptions.length === 0) return true
          const selectedSet = new Set(filter.types)
          const allOptionsSelected = allOptions.every((option) => {
            return selectedSet.has(option)
          })
          return !allOptionsSelected
        })

        console.log(
          `[export] Prompt filters: ${promptSelections.length} provided, ${effectivePromptSelections.length} effective (after removing "all selected")`,
        )

        if (effectivePromptSelections.length > 0) {
          const allFilterPromptIds = effectivePromptSelections.map((filter) => {
            return filter.promptId
          })
          const judgmentRows = await appDatabaseService.queryJson<{
            articleId: string
            promptId: string
            answeredOriginal: string | null
            answeredOriginalAsArray: unknown
          }>(`
            SELECT
              j.article_id AS articleId,
              j.prompt_id AS promptId,
              j.answered_original AS answeredOriginal,
              TO_JSON(j.answered_original_as_array) AS answeredOriginalAsArray
            FROM app.judgment j
            INNER JOIN app.article a ON a.id = j.article_id
            WHERE ${getAndClause([
              `j.prompt_id IN (${getQuotedStringList(allFilterPromptIds).join(', ')})`,
              'j.deleted_at IS NULL',
              judgmentConfigCondition,
              scopeCondition,
            ])}
          `)
          const normalizedRows = judgmentRows.map((row) => {
            const parsedArray = getJsonValue(row.answeredOriginalAsArray)

            return {
              ...row,
              answeredOriginalAsArray: Array.isArray(parsedArray)
                ? parsedArray.filter((value): value is string => {
                    return typeof value === 'string'
                  })
                : null,
            }
          })
          const rowsByArticleId = normalizedRows.reduce<Map<string, typeof normalizedRows>>((rowMap, row) => {
            const currentRows = rowMap.get(row.articleId) ?? []
            currentRows.push(row)
            rowMap.set(row.articleId, currentRows)
            return rowMap
          }, new Map<string, typeof normalizedRows>())

          filteredArticleIds = Array.from(rowsByArticleId.entries())
            .filter(([, rows]) => {
              return effectivePromptSelections.every((selection) => {
                return rows.some((row) => {
                  return row.promptId === selection.promptId && hasMatchingJudgmentAnswer(row, selection.types)
                })
              })
            })
            .map(([articleId]) => {
              return articleId
            })
          console.log(`[export] Filtered to ${filteredArticleIds.length} articles based on prompt answer filters`)
        } else {
          console.log('[export] All prompt filters had all options selected - treating as no filter')
        }
      }

      const finalScopeCondition =
        filteredArticleIds !== null
          ? filteredArticleIds.length > 0
            ? getAndClause([scopeCondition, `a.id IN (${getQuotedStringList(filteredArticleIds).join(', ')})`])
            : 'FALSE'
          : scopeCondition
      const orderedPromptIds = promptIds.filter((id) => {
        return promptHeaderMap.has(id)
      })
      const headers: string[] = ['Title']

      if (includeArticleId) headers.push('Article ID')
      if (includeArticleLink) headers.push('Article Link')
      if (includeArticleAuthors) headers.push('Article Authors')
      if (includeSummary) headers.push('Abstract/Summary')
      if (includeJournal) headers.push('Journal')
      if (includeArticleCreatedAt) headers.push('Article Created At')
      if (includeArticleUpdatedAt) headers.push('Article Updated At')

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
        if (includeExplanation) headers.push(`${baseHeading} - Explanation`)
        if (includeQuotes) headers.push(`${baseHeading} - Quotes`)
      }

      const filename = `${project.name.replace(/[^a-zA-Z0-9]/g, '_')}_export_${new Date().toISOString().slice(0, 10)}.csv`
      set.headers['Content-Type'] = 'text/csv; charset=utf-8'
      set.headers['Content-Disposition'] = `attachment; filename="${filename}"`

      const stream = new ReadableStream({
        async start(controller) {
          try {
            controller.enqueue(headers.map(escapeCSV).join(',') + '\n')

            let offset = 0
            let processedCount = 0

            if (hasPrompts && judgmentConfigCondition) {
              const [countResult] = await appDatabaseService.queryJson<{count: number}>(`
                SELECT count(DISTINCT a.id) AS count
                FROM app.article a
                INNER JOIN app.judgment j ON ${getAndClause([
                  'j.article_id = a.id',
                  `j.prompt_id IN (${getQuotedStringList(promptIds).join(', ')})`,
                  'j.deleted_at IS NULL',
                  judgmentConfigCondition,
                ])}
                WHERE ${finalScopeCondition}
              `)
              const totalCount = Number(countResult?.count ?? 0)
              console.log(`[export] Starting export of ~${totalCount} articles with prompts`)

              while (true) {
                const batchData = await appDatabaseService.queryJson<{
                  articleId: string
                  articleExternalId: string | null
                  articleTitle: string | null
                  articleSummary: string | null
                  articleAuthors: unknown
                  articleCreatedAt: unknown
                  articleUpdatedAt: unknown
                  articleOriginalData: unknown
                  promptId: string
                  answeredOriginal: string | null
                  answeredOriginalAsArray: unknown
                  explanation: string | null
                  quotes: unknown
                }>(`
                  SELECT
                    a.id AS articleId,
                    a.article_id AS articleExternalId,
                    a.article_title AS articleTitle,
                    a.article_summary AS articleSummary,
                    TO_JSON(a.article_authors) AS articleAuthors,
                    a.article_created_at AS articleCreatedAt,
                    a.article_updated_at AS articleUpdatedAt,
                    ${includeJournal ? 'TO_JSON(a.original_data)' : 'NULL'} AS articleOriginalData,
                    j.prompt_id AS promptId,
                    j.answered_original AS answeredOriginal,
                    TO_JSON(j.answered_original_as_array) AS answeredOriginalAsArray,
                    j.explanation AS explanation,
                    TO_JSON(j.quotes) AS quotes
                  FROM app.article a
                  INNER JOIN app.judgment j ON ${getAndClause([
                    'j.article_id = a.id',
                    `j.prompt_id IN (${getQuotedStringList(promptIds).join(', ')})`,
                    'j.deleted_at IS NULL',
                    judgmentConfigCondition,
                  ])}
                  WHERE ${finalScopeCondition}
                  ORDER BY a.id ASC
                  LIMIT ${BATCH_SIZE * promptIds.length}
                  OFFSET ${offset}
                `)

                if (batchData.length === 0) {
                  break
                }

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
                    const articleAuthors = getJsonValue(row.articleAuthors)
                    batchArticleMap.set(row.articleId, {
                      title: row.articleTitle || 'Untitled',
                      articleId: articleExternalId,
                      articleUrl: includeArticleLink ? getArticleUrl(articleExternalId) : '',
                      authors:
                        includeArticleAuthors && Array.isArray(articleAuthors)
                          ? articleAuthors
                              .filter((value): value is string => {
                                return typeof value === 'string'
                              })
                              .join('; ')
                          : '',
                      createdAt: includeArticleCreatedAt ? formatArticleDate(getDateValue(row.articleCreatedAt)) : '',
                      updatedAt: includeArticleUpdatedAt ? formatArticleDate(getDateValue(row.articleUpdatedAt)) : '',
                      summary: row.articleSummary || '',
                      journalTitle: includeJournal
                        ? (getJournalTitleFromOriginalData(getJsonValue(row.articleOriginalData)) ?? '')
                        : '',
                      answers: new Map(),
                      explanations: new Map(),
                      quotes: new Map(),
                    })
                  }

                  const article = batchArticleMap.get(row.articleId)
                  if (article) {
                    const parsedAnswerArray = getJsonValue(row.answeredOriginalAsArray)
                    const answer =
                      Array.isArray(parsedAnswerArray) && parsedAnswerArray.length > 0
                        ? parsedAnswerArray
                            .filter((value): value is string => {
                              return typeof value === 'string'
                            })
                            .join('; ')
                        : (row.answeredOriginal ?? '')
                    article.answers.set(row.promptId, answer)

                    if (includeExplanation && row.explanation) {
                      article.explanations.set(row.promptId, row.explanation)
                    }

                    if (includeQuotes) {
                      const quotesValue = getJsonValue(row.quotes)
                      const quotes = Array.isArray(quotesValue)
                        ? quotesValue
                            .map((value) => {
                              return typeof value === 'string' ? value : JSON.stringify(value)
                            })
                            .join('; ')
                        : typeof quotesValue === 'string'
                          ? quotesValue
                          : quotesValue === null || quotesValue === undefined
                            ? ''
                            : JSON.stringify(quotesValue)
                      if (quotes) {
                        article.quotes.set(row.promptId, quotes)
                      }
                    }
                  }
                }

                for (const articleData of batchArticleMap.values()) {
                  const row: string[] = [articleData.title]
                  if (includeArticleId) row.push(articleData.articleId)
                  if (includeArticleLink) row.push(articleData.articleUrl)
                  if (includeArticleAuthors) row.push(articleData.authors)
                  if (includeSummary) row.push(articleData.summary)
                  if (includeJournal) row.push(articleData.journalTitle)
                  if (includeArticleCreatedAt) row.push(articleData.createdAt)
                  if (includeArticleUpdatedAt) row.push(articleData.updatedAt)

                  for (const promptId of orderedPromptIds) {
                    row.push(articleData.answers.get(promptId) || '')
                    if (includeExplanation) row.push(articleData.explanations.get(promptId) || '')
                    if (includeQuotes) row.push(articleData.quotes.get(promptId) || '')
                  }

                  controller.enqueue(row.map(escapeCSV).join(',') + '\n')
                  processedCount += 1
                }

                offset += batchData.length
                console.log(`[export] Streamed ${processedCount} articles`)

                if (batchData.length < BATCH_SIZE * promptIds.length) {
                  break
                }
              }
            } else {
              const [countResult] = await appDatabaseService.queryJson<{count: number}>(`
                SELECT count(a.id) AS count
                FROM app.article a
                WHERE ${finalScopeCondition}
              `)
              const totalCount = Number(countResult?.count ?? 0)
              console.log(`[export] Starting export of ~${totalCount} articles (metadata only)`)

              while (true) {
                const batchData = await appDatabaseService.queryJson<{
                  articleId: string
                  articleExternalId: string | null
                  articleTitle: string | null
                  articleSummary: string | null
                  articleAuthors: unknown
                  articleCreatedAt: unknown
                  articleUpdatedAt: unknown
                  articleOriginalData: unknown
                }>(`
                  SELECT
                    a.id AS articleId,
                    a.article_id AS articleExternalId,
                    a.article_title AS articleTitle,
                    a.article_summary AS articleSummary,
                    TO_JSON(a.article_authors) AS articleAuthors,
                    a.article_created_at AS articleCreatedAt,
                    a.article_updated_at AS articleUpdatedAt,
                    ${includeJournal ? 'TO_JSON(a.original_data)' : 'NULL'} AS articleOriginalData
                  FROM app.article a
                  WHERE ${finalScopeCondition}
                  ORDER BY a.id ASC
                  LIMIT ${BATCH_SIZE}
                  OFFSET ${offset}
                `)

                if (batchData.length === 0) {
                  break
                }

                for (const row of batchData) {
                  const articleExternalId = row.articleExternalId ?? ''
                  const articleAuthors = getJsonValue(row.articleAuthors)
                  const csvRow: string[] = [row.articleTitle || 'Untitled']
                  if (includeArticleId) csvRow.push(articleExternalId)
                  if (includeArticleLink) csvRow.push(getArticleUrl(articleExternalId))
                  if (includeArticleAuthors) {
                    csvRow.push(
                      Array.isArray(articleAuthors)
                        ? articleAuthors
                            .filter((value): value is string => {
                              return typeof value === 'string'
                            })
                            .join('; ')
                        : '',
                    )
                  }
                  if (includeSummary) csvRow.push(row.articleSummary || '')
                  if (includeJournal) {
                    csvRow.push(getJournalTitleFromOriginalData(getJsonValue(row.articleOriginalData)) ?? '')
                  }
                  if (includeArticleCreatedAt) csvRow.push(formatArticleDate(getDateValue(row.articleCreatedAt)))
                  if (includeArticleUpdatedAt) csvRow.push(formatArticleDate(getDateValue(row.articleUpdatedAt)))

                  controller.enqueue(csvRow.map(escapeCSV).join(',') + '\n')
                  processedCount += 1
                }

                offset += batchData.length
                console.log(`[export] Streamed ${processedCount} articles`)

                if (batchData.length < BATCH_SIZE) {
                  break
                }
              }
            }

            console.log(`[export] Export complete: ${processedCount} articles`)
            controller.close()
          } catch (error) {
            console.error('[export] Error:', error)
            controller.error(error)
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
        promptSelections: t.Optional(t.Array(t.Object({promptId: t.String(), types: t.Array(t.String())}))),
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
      await assertProjectIsActive(params.id)

      const [project] = await appDatabaseService.queryJson<{id: string; name: string}>(`
        SELECT id, name
        FROM app.project
        WHERE id = ${getSqlLiteral(params.id)}
        LIMIT 1
      `)
      if (!project) {
        throw new Error('Project not found')
      }

      const promptIds = body.promptIds
      if (!promptIds || promptIds.length === 0) {
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
        WHERE id IN (${getQuotedStringList(promptIds).join(', ')})
      `)
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
