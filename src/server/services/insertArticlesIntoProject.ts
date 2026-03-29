import {getAppDatabaseService} from './appDatabaseService.ts'
import {escapeSqlString, getQuotedStringList} from './appQueryHelpers.ts'
import {getDuckdbMartRefreshService} from './getDuckdbMartRefreshService.ts'

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
  const database = getAppDatabaseService()
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
  // Chunk queries to avoid oversized SQLite statements.
  const existingArticleSet = new Set<string>()
  const lookupBatchSize = 10000
  for (const idsChunk of chunk(uniqueIds, lookupBatchSize)) {
    if (idsChunk.length === 0) continue
    const rows = await database.queryJson<{id: string}>(`
      SELECT id
      FROM app.article
      WHERE id IN (${getQuotedStringList(idsChunk).join(', ')})
    `)
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
  // Chunk queries to avoid oversized SQLite statements.
  const existingAssocSet = new Set<string>()
  for (const idsChunk of chunk(validIds, lookupBatchSize)) {
    if (idsChunk.length === 0) continue
    const rows = await database.queryJson<{articleId: string}>(`
      SELECT article_id AS articleId
      FROM app.project_article
      WHERE project_id = '${escapeSqlString(projectId)}'
        AND article_id IN (${getQuotedStringList(idsChunk).join(', ')})
    `)
    for (const r of rows) {
      existingAssocSet.add(r.articleId)
    }
  }
  const toInsert = validIds.filter((id) => {
    return !existingAssocSet.has(id)
  })

  // Auto-link prompts that already have judgments (AI or human) for these articles
  let linkedPrompts = 0
  let ensuredPromptIds: string[] = []
  if (validIds.length > 0) {
    // Query prompts with judgments in chunks to avoid parameter limits.
    const llmPromptIdSet = new Set<string>()
    const humanPromptIdSet = new Set<string>()
    for (const idsChunk of chunk(validIds, lookupBatchSize)) {
      if (idsChunk.length === 0) continue
      const llmRows = await database.queryJson<{pid: string}>(`
        SELECT prompt_id AS pid
        FROM app.judgment
        WHERE article_id IN (${getQuotedStringList(idsChunk).join(', ')})
        GROUP BY prompt_id
      `)
      for (const r of llmRows) {
        if (r.pid) llmPromptIdSet.add(r.pid)
      }
      const humanRows = await database.queryJson<{pid: string}>(`
        SELECT prompt_id AS pid
        FROM app.judgment_human
        WHERE article_id IN (${getQuotedStringList(idsChunk).join(', ')})
        GROUP BY prompt_id
      `)
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
      const existingProjectPromptRows = await database.queryJson<{pid: string}>(`
        SELECT prompt_id AS pid
        FROM app.project_prompt
        WHERE project_id = '${escapeSqlString(projectId)}'
      `)
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
        const ensurePrompts = await database.queryJson<{id: string}>(`
          SELECT id
          FROM app.prompt
          WHERE id IN (${getQuotedStringList(toLink).join(', ')})
        `)
        ensuredPromptIds = ensurePrompts.map((r) => {
          return r.id
        })
        linkedPrompts = ensuredPromptIds.length
      }
    }
  }

  const batchSize = 1000
  await database.transaction(async (tx) => {
    for (const idsChunk of chunk(toInsert, batchSize)) {
      if (idsChunk.length === 0) continue
      await tx.run(`
        INSERT INTO app.project_article (id, project_id, article_id, imported_from_project_id)
        VALUES ${idsChunk
          .map((articleId) => {
            return `(${getQuotedStringList([crypto.randomUUID(), projectId, articleId]).join(', ')}, ${importedFromProjectId ? `'${escapeSqlString(importedFromProjectId)}'` : 'NULL'})`
          })
          .join(', ')}
        ON CONFLICT(project_id, article_id) DO NOTHING
      `)
    }

    let orderIndex = 0
    for (const promptChunk of chunk(ensuredPromptIds, batchSize)) {
      if (promptChunk.length === 0) continue
      const values = promptChunk.map((pid, index) => {
        return `(${getQuotedStringList([crypto.randomUUID(), projectId, pid]).join(', ')}, ${orderIndex + index}, FALSE, NULL, FALSE)`
      })
      orderIndex += promptChunk.length
      await tx.run(`
        INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, archived, origin_project_id, enabled)
        VALUES ${values.join(', ')}
        ON CONFLICT(project_id, prompt_id) DO NOTHING
      `)
    }
  })

  if (toInsert.length > 0 || linkedPrompts > 0) {
    await getDuckdbMartRefreshService().queueProjectRefresh(projectId, 'insertArticlesIntoProject')
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
