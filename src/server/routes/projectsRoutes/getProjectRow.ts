import {escapeSqlString} from '../../services/appQueryHelpers.ts'
import type {AppQueryRunner} from './appTx.ts'
import {getProjectFullTextSelectSql, type ProjectFullTextRow} from './projectFullTextSettings.ts'

export type ProjectRow = {
  humanJudgmentMode?: 'prompt' | 'summary' | null
  id: string
  name: string
  description: string | null
  modelId: string
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useMetadata: boolean
  systemPromptVariant?: string | null
  dateFrom: unknown
  dateTo: unknown
  archived: boolean
  createdAt: unknown
  updatedAt: unknown
} & ProjectFullTextRow

const getProjectRowSql = (projectId: string) => {
  return `
    SELECT
      id,
      name,
      description,
      model_id AS modelId,
      use_title AS useTitle,
      use_abstract AS useAbstract,
      use_fulltext AS useFulltext,
      use_fulltext_no_images AS useFulltextNoImages,
      COALESCE(use_metadata, FALSE) AS useMetadata,
      human_judgment_mode AS humanJudgmentMode,
      system_prompt_variant AS systemPromptVariant,
      ${getProjectFullTextSelectSql('app.project')},
      date_from AS dateFrom,
      date_to AS dateTo,
      archived,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM app.project
    WHERE id = '${escapeSqlString(projectId)}'
      AND delete_pending_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM app.archived_project_delete_tombstone tombstone
        WHERE tombstone.project_id = app.project.id
          AND tombstone.completed_at IS NULL
      )
    LIMIT 1
  `
}

export const getProjectRow = async (db: AppQueryRunner, projectId: string) => {
  const [project] = await db.queryJson<ProjectRow>(getProjectRowSql(projectId))
  return project ?? null
}
