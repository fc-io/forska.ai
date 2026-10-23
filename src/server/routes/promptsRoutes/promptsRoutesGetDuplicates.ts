import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString} from '../../services/appQueryHelpers.ts'
import type {PromptRow} from './promptRow.ts'

export const promptsRoutesGetDuplicates = async () => {
  const allPrompts = await getAppDatabaseService().queryJson<
    PromptRow & {archived: boolean; createdAt: unknown; updatedAt: unknown}
  >(`
      SELECT
        id,
        original_text AS originalText,
        transformed_text AS transformedText,
        prompt_heading AS promptHeading,
        type,
        archived,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM app.prompt
    `)

  // Group by content
  const groups = new Map<string, typeof allPrompts>()
  for (const p of allPrompts) {
    // Create a key based on content fields
    const key = JSON.stringify({originalText: p.originalText, promptHeading: p.promptHeading, type: p.type})

    const group = groups.get(key)
    if (group) {
      group.push(p)
    } else {
      groups.set(key, [p])
    }
  }

  // Filter for duplicates
  const duplicateGroups = Array.from(groups.values()).filter((group) => {
    return group.length > 1
  })

  // Enrich with usage stats
  const result = await Promise.all(
    duplicateGroups.map(async (group) => {
      const enrichedPrompts = await Promise.all(
        group.map(async (p) => {
          const [[projectCount], [judgmentCount], [humanJudgmentCount], projects] = await Promise.all([
            getAppDatabaseService().queryJson<{count: number}>(`
                SELECT COUNT(*) AS count
                FROM app.project_prompt
                WHERE prompt_id = '${escapeSqlString(p.id)}'
              `),
            getAppDatabaseService().queryJson<{count: number}>(`
                SELECT COUNT(*) AS count
                FROM app.judgment
                WHERE prompt_id = '${escapeSqlString(p.id)}'
              `),
            getAppDatabaseService().queryJson<{count: number}>(`
                SELECT COUNT(*) AS count
                FROM app.judgment_human
                WHERE prompt_id = '${escapeSqlString(p.id)}'
              `),
            getAppDatabaseService().queryJson<{id: string}>(`
                SELECT project_id AS id
                FROM app.project_prompt
                WHERE prompt_id = '${escapeSqlString(p.id)}'
              `),
          ])

          return {
            ...p,
            usage: {
              projects: Number(projectCount?.count ?? 0),
              judgments: Number(judgmentCount?.count ?? 0),
              humanJudgments: Number(humanJudgmentCount?.count ?? 0),
              projectIds: projects.map((pr) => {
                return pr.id
              }),
            },
          }
        }),
      )
      return enrichedPrompts
    }),
  )

  return {success: true, data: result}
}
