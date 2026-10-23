import {escapeSqlString} from '../../../services/appQueryHelpers.ts'
import type {AppQueryRunner} from '../appTx.ts'

export const getProjectEditResponsePrompts = async (db: AppQueryRunner, projectId: string) => {
  return db.queryJson<{
    id: string
    originalText: string
    transformedText: string | null
    promptHeading: string | null
    order: number | null
    archived: boolean
    promptArchived: boolean
    type: string | null
    enabled: boolean
    originProjectId: string | null
    linkedToProject: boolean
  }>(`
    SELECT
      p.id AS id,
      p.original_text AS originalText,
      p.transformed_text AS transformedText,
      p.prompt_heading AS promptHeading,
      pp.prompt_order AS "order",
      pp.archived AS archived,
      p.archived AS promptArchived,
      p.type AS type,
      pp.enabled AS enabled,
      pp.origin_project_id AS originProjectId,
      TRUE AS linkedToProject
    FROM app.project_prompt pp
    INNER JOIN app.prompt p ON pp.prompt_id = p.id
    WHERE pp.project_id = '${escapeSqlString(projectId)}'
    ORDER BY pp.prompt_order ASC NULLS LAST
  `)
}
