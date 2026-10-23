import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getDateValue} from '../../services/appQueryHelpers.ts'

export const promptsRoutesGetOrphans = async () => {
  const [noProjects, noJudgments, noProjectsAndJudgments] = await Promise.all([
    getAppDatabaseService().queryJson<{
      id: string
      originalText: string
      promptHeading: string | null
      type: string | null
      createdAt: unknown
    }>(`
        SELECT id, original_text AS originalText, prompt_heading AS promptHeading, type, created_at AS createdAt
        FROM app.prompt p
        WHERE NOT EXISTS (
          SELECT 1 FROM app.project_prompt pp WHERE pp.prompt_id = p.id LIMIT 1
        )
      `),
    getAppDatabaseService().queryJson<{
      id: string
      originalText: string
      promptHeading: string | null
      type: string | null
      createdAt: unknown
    }>(`
        SELECT id, original_text AS originalText, prompt_heading AS promptHeading, type, created_at AS createdAt
        FROM app.prompt p
        WHERE NOT EXISTS (SELECT 1 FROM app.judgment j WHERE j.prompt_id = p.id LIMIT 1)
          AND NOT EXISTS (SELECT 1 FROM app.judgment_human jh WHERE jh.prompt_id = p.id LIMIT 1)
      `),
    getAppDatabaseService().queryJson<{
      id: string
      originalText: string
      promptHeading: string | null
      type: string | null
      createdAt: unknown
    }>(`
        SELECT id, original_text AS originalText, prompt_heading AS promptHeading, type, created_at AS createdAt
        FROM app.prompt p
        WHERE NOT EXISTS (SELECT 1 FROM app.project_prompt pp WHERE pp.prompt_id = p.id LIMIT 1)
          AND NOT EXISTS (SELECT 1 FROM app.judgment j WHERE j.prompt_id = p.id LIMIT 1)
          AND NOT EXISTS (SELECT 1 FROM app.judgment_human jh WHERE jh.prompt_id = p.id LIMIT 1)
      `),
  ])

  const normalizeRows = <TRow extends {createdAt: unknown}>(rows: TRow[]) => {
    return rows.map((row) => {
      return {...row, createdAt: getDateValue(row.createdAt)}
    })
  }

  return {
    success: true,
    data: {
      noProjects: normalizeRows(noProjects),
      noJudgments: normalizeRows(noJudgments),
      noProjectsAndJudgments: normalizeRows(noProjectsAndJudgments),
    },
  }
}
