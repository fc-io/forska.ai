import {and, eq, inArray} from 'drizzle-orm'

import {articles, judgments, judgmentsHuman, projectArticles, projectPrompts, prompts} from '../../db/schema.ts'
import {getDatabase} from '../utils/getDatabase.ts'

const chunk = <T>(arr: T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

export type InsertArticlesResult = {
  projectId: string
  totalProvided: number
  totalValid: number
  invalidIds: string[]
  existingAssociations: number
  insertedCount: number
  linkedPrompts: number
}

/**
 * Insert article associations into project_articles with ON CONFLICT DO NOTHING,
 * and auto-link prompts that already have judgments for these articles.
 */
export const insertArticlesIntoProject = async (
  projectId: string,
  articleIdsInput: string[],
  importedFromProjectId?: string | null,
): Promise<InsertArticlesResult> => {
  const db = getDatabase()

  const uniqueIds = Array.from(
    new Set(
      (Array.isArray(articleIdsInput) ? articleIdsInput : [articleIdsInput]).filter((v): v is string => {
        return typeof v === 'string' && v.trim().length > 0
      }),
    ),
  )

  if (uniqueIds.length === 0) {
    return {
      projectId,
      totalProvided: 0,
      totalValid: 0,
      invalidIds: [],
      existingAssociations: 0,
      insertedCount: 0,
      linkedPrompts: 0,
    }
  }

  // Filter to IDs that exist in articles to avoid FK errors.
  // Chunk queries to avoid exceeding PostgreSQL's parameter limit (~32k).
  const existingArticleSet = new Set<string>()
  const lookupBatchSize = 10000
  for (const idsChunk of chunk(uniqueIds, lookupBatchSize)) {
    if (idsChunk.length === 0) continue
    const rows = await db.select({id: articles.id}).from(articles).where(inArray(articles.id, idsChunk))
    for (const r of rows) {
      existingArticleSet.add(r.id)
    }
  }
  const validIds = uniqueIds.filter((id) => {
    return existingArticleSet.has(id)
  })
  const invalidIds = uniqueIds.filter((id) => {
    return !existingArticleSet.has(id)
  })

  if (validIds.length === 0) {
    return {
      projectId,
      totalProvided: uniqueIds.length,
      totalValid: 0,
      invalidIds,
      existingAssociations: 0,
      insertedCount: 0,
      linkedPrompts: 0,
    }
  }

  // Count existing associations to compute inserted count deterministically.
  // Chunk queries to avoid exceeding PostgreSQL's parameter limit.
  const existingAssocSet = new Set<string>()
  for (const idsChunk of chunk(validIds, lookupBatchSize)) {
    if (idsChunk.length === 0) continue
    const rows = await db
      .select({articleId: projectArticles.articleId})
      .from(projectArticles)
      .where(and(eq(projectArticles.projectId, projectId), inArray(projectArticles.articleId, idsChunk)))
    for (const r of rows) {
      existingAssocSet.add(r.articleId)
    }
  }
  const toInsert = validIds.filter((id) => {
    return !existingAssocSet.has(id)
  })

  // Insert associations in chunks, ignoring duplicates just in case concurrent requests race
  const batchSize = 1000
  for (const idsChunk of chunk(toInsert, batchSize)) {
    if (idsChunk.length === 0) continue
    await db
      .insert(projectArticles)
      .values(
        idsChunk.map((articleId) => {
          return {projectId, articleId, importedFromProjectId: importedFromProjectId ?? null}
        }),
      )
      .onConflictDoNothing({target: [projectArticles.projectId, projectArticles.articleId]})
  }

  // Auto-link prompts that already have judgments (AI or human) for these articles
  let linkedPrompts = 0
  if (validIds.length > 0) {
    // Query prompts with judgments in chunks to avoid parameter limits.
    const llmPromptIdSet = new Set<string>()
    const humanPromptIdSet = new Set<string>()
    for (const idsChunk of chunk(validIds, lookupBatchSize)) {
      if (idsChunk.length === 0) continue
      const llmRows = await db
        .select({pid: judgments.promptId})
        .from(judgments)
        .where(inArray(judgments.articleId, idsChunk))
        .groupBy(judgments.promptId)
      for (const r of llmRows) {
        if (r.pid) llmPromptIdSet.add(r.pid)
      }
      const humanRows = await db
        .select({pid: judgmentsHuman.promptId})
        .from(judgmentsHuman)
        .where(inArray(judgmentsHuman.articleId, idsChunk))
        .groupBy(judgmentsHuman.promptId)
      for (const r of humanRows) {
        if (r.pid) humanPromptIdSet.add(r.pid)
      }
    }

    const promptIds = Array.from(new Set([...Array.from(llmPromptIdSet), ...Array.from(humanPromptIdSet)])).filter(
      (id): id is string => {
        return typeof id === 'string' && id.length > 0
      },
    )

    if (promptIds.length > 0) {
      // Exclude prompts already linked to this project
      const existingProjectPromptRows = await db
        .select({pid: projectPrompts.promptId})
        .from(projectPrompts)
        .where(eq(projectPrompts.projectId, projectId))
      const existingProjectPromptSet = new Set(
        existingProjectPromptRows.map((r) => {
          return r.pid
        }),
      )
      const toLink = promptIds.filter((pid) => {
        return !existingProjectPromptSet.has(pid)
      })

      if (toLink.length > 0) {
        // Ensure prompts exist, then link with default metadata
        const ensurePrompts = await db.select({id: prompts.id}).from(prompts).where(inArray(prompts.id, toLink))
        const ensureIds = ensurePrompts.map((r) => {
          return r.id
        })
        if (ensureIds.length > 0) {
          linkedPrompts = ensureIds.length
          // Insert in chunks to be safe for very large prompt sets.
          // Keep a contiguous order across chunks.
          let orderIndex = 0
          for (const promptChunk of chunk(ensureIds, 1000)) {
            const values = promptChunk.map((pid, index) => {
              return {
                projectId,
                promptId: pid,
                order: orderIndex + index,
                archived: false,
                // Auto-linked prompts are not created by this project and start disabled.
                originProjectId: null,
                enabled: false,
              }
            })
            orderIndex += promptChunk.length
            await db
              .insert(projectPrompts)
              .values(values)
              .onConflictDoNothing({target: [projectPrompts.projectId, projectPrompts.promptId]})
          }
        }
      }
    }
  }

  return {
    projectId,
    totalProvided: uniqueIds.length,
    totalValid: validIds.length,
    invalidIds,
    existingAssociations: existingAssocSet.size,
    insertedCount: toInsert.length,
    linkedPrompts,
  }
}
