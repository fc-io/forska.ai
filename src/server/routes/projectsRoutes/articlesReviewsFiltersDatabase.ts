/**
 * Retrieves filter options for prompts using the database-based strategy.
 *
 * This strategy queries the judgments table for distinct answered values,
 * used when the prompt type is open-ended (e.g., `string` or `string[]`).
 */

import type {SQL} from 'drizzle-orm'
import {and, gte, inArray, lte, sql} from 'drizzle-orm'

import {articles, judgments} from '../../../db/schema.ts'
import type {PromptFilterInfo} from './articlesReviewsFiltersUtils.ts'

export type DatabaseFilterResult = {promptId: string; promptName: string; answeredOriginalValues: string[]}

export type DatabaseFilterParams = {
  prompts: PromptFilterInfo[]
  scopeCondition: SQL | undefined
  projectBounds: {dateFrom: Date | null; dateTo: Date | null} | undefined
  fromDate: Date | null
  toDate: Date | null
  searchTitle: string
}

/**
 * Get filter options by querying distinct values from the judgments table.
 * Used for prompts with open-ended types (string, string[], etc.).
 */
export const getDatabaseBasedFilters = async (
  db: ReturnType<typeof import('../../utils/getDatabase.ts').getDatabase>,
  params: DatabaseFilterParams,
): Promise<DatabaseFilterResult[]> => {
  const databasePrompts = params.prompts.filter((p) => {
    return p.strategy === 'database'
  })

  if (databasePrompts.length === 0) {
    return []
  }

  const promptIds = databasePrompts.map((p) => {
    return p.promptId
  })

  // Build WHERE conditions
  const whereParts: Array<SQL | undefined> = [inArray(judgments.promptId, promptIds), params.scopeCondition]
  if (params.projectBounds?.dateFrom) whereParts.push(gte(articles.articleCreatedAt, params.projectBounds.dateFrom))
  if (params.projectBounds?.dateTo) whereParts.push(lte(articles.articleCreatedAt, params.projectBounds.dateTo))
  if (params.fromDate) whereParts.push(gte(articles.articleCreatedAt, params.fromDate))
  if (params.toDate) whereParts.push(lte(articles.articleCreatedAt, params.toDate))
  if (params.searchTitle) whereParts.push(sql`${articles.articleTitle} ILIKE ${'%' + params.searchTitle + '%'}`)

  const normalized = sql`COALESCE(${judgments.answeredOriginalAsArray}, CASE WHEN ${judgments.answeredOriginal} IS NOT NULL THEN ARRAY[${judgments.answeredOriginal}] ELSE ARRAY[]::text[] END)`
  const combinedWhere = and(
    ...whereParts.filter((p): p is SQL => {
      return p !== undefined
    }),
  )

  const grouped = await db.execute(
    sql`
      SELECT ${judgments.promptId} AS "promptId", elem AS "value"
      FROM ${judgments}
      INNER JOIN ${articles} ON ${articles.id} = ${judgments.articleId}
      CROSS JOIN LATERAL UNNEST(${normalized}) AS elem
      WHERE ${combinedWhere}
      GROUP BY ${judgments.promptId}, elem
      ORDER BY ${judgments.promptId}, elem
    `,
  )

  const byPrompt = new Map<string, string[]>()
  for (const row of grouped.rows as Array<{promptId: string; value: string}>) {
    const arr = byPrompt.get(row.promptId) || []
    if (row.value !== null && row.value !== undefined) arr.push(row.value)
    byPrompt.set(row.promptId, arr)
  }

  return databasePrompts.map((p) => {
    return {promptId: p.promptId, promptName: p.promptName, answeredOriginalValues: byPrompt.get(p.promptId) || []}
  })
}
