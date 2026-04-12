import {type as arktype} from 'arktype'
import type {Context} from 'elysia'

import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString, getQuotedStringList, getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {getProjectMartRefreshStateService} from '../../services/projectMartRefreshStateService.ts'

export const humanAssessmentRoutesPostSubmit = async ({
  body,
  set,
}: {
  body: {projectId: string; answers: Array<{judgmentHumanId: string; answer: string; comment?: string}>}
  set: Context['set']
}) => {
  const [project] = await getAppDatabaseService().queryJson<{humanJudgmentMode: 'prompt' | 'summary' | null}>(`
    SELECT human_judgment_mode AS humanJudgmentMode
    FROM app.project
    WHERE id = '${escapeSqlString(body.projectId)}'
    LIMIT 1
  `)
  const humanJudgmentMode = project?.humanJudgmentMode ?? 'prompt'

  if (humanJudgmentMode === 'summary') {
    set.status = 409
    return {data: null, error: 'Summary-mode projects do not support prompt-based human assessment'}
  }

  const pending = await getAppDatabaseService().queryJson<{
    id: string
    promptId: string
    articleId: string
    type: string | null
  }>(`
    SELECT
      jh.id AS id,
      jh.prompt_id AS promptId,
      jh.article_id AS articleId,
      p.type AS type
    FROM app.judgment_human jh
    INNER JOIN app.prompt p ON jh.prompt_id = p.id
    INNER JOIN app.project_prompt pp ON pp.prompt_id = p.id AND pp.project_id = '${escapeSqlString(body.projectId)}'
    WHERE jh.project_id = '${escapeSqlString(body.projectId)}'
      AND jh.is_answered = FALSE
  `)

  if (pending.length === 0) {
    set.status = 400
    return {data: null, error: 'No pending human assessments for this project'}
  }

  const articleIds = Array.from(
    new Set(
      pending.map((p) => {
        return p.articleId
      }),
    ),
  )

  if (articleIds.length !== 1) {
    set.status = 400
    return {data: null, error: 'Multiple pending articles detected; please refresh and try again'}
  }

  const [currentArticleId = ''] = articleIds

  const requiredPending = pending.filter((p) => {
    return !(p.type ?? '').toLowerCase().includes('null')
  })
  const allPendingIds = new Set(
    pending.map((p) => {
      return p.id
    }),
  )
  const expectedIds = new Set(
    requiredPending.map((p) => {
      return p.id
    }),
  )

  const submittedIds = new Set(
    body.answers.map((a) => {
      return a.judgmentHumanId
    }),
  )

  const missingRequired = Array.from(expectedIds).some((id) => {
    return !submittedIds.has(id)
  })
  if (missingRequired) {
    set.status = 400
    return {data: null, error: 'Missing answers for one or more required prompts'}
  }

  const hasOnlyPending = Array.from(submittedIds).every((id) => {
    return allPendingIds.has(id)
  })
  if (!hasOnlyPending) {
    set.status = 400
    return {data: null, error: 'Submission contains answers for non-pending prompts'}
  }

  const byId = body.answers.reduce<Record<string, {answer: string; comment?: string}>>((acc, a) => {
    const key = a.judgmentHumanId
    acc[key] = {answer: a.answer, comment: a.comment}
    return acc
  }, {})

  for (const row of pending) {
    const submitted = byId[row.id]
    const value = submitted?.answer
    const typeStr = row.type ?? 'string'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Type = arktype(typeStr as any)

    const isOptional = (row.type ?? '').toLowerCase().includes('null')
    if (!isOptional) {
      if (value == null || `${value}`.trim() === '') {
        set.status = 400
        return {data: null, error: 'All required prompts must have a non-empty answer'}
      }
      try {
        Type.assert(value)
      } catch {
        set.status = 400
        return {data: null, error: `Answer does not match required type for a prompt (${typeStr})`}
      }
    } else if (value != null && `${value}`.trim() !== '') {
      try {
        Type.assert(value)
      } catch {
        set.status = 400
        return {data: null, error: `Answer does not match required type for a prompt (${typeStr})`}
      }
    }
  }

  const idsToUpdate = Array.from(submittedIds)
  const updatedAt = new Date()
  const answerCase = idsToUpdate
    .map((id) => {
      const payload = byId[id]
      const raw = payload?.answer
      const value = typeof raw === 'string' ? raw : raw == null ? '' : String(raw)
      const preparedAnswer = value.trim() === '' ? null : value
      return `WHEN id = '${escapeSqlString(id)}' THEN ${getSqlLiteral(preparedAnswer)}`
    })
    .join(' ')
  const commentCase = idsToUpdate
    .map((id) => {
      return `WHEN id = '${escapeSqlString(id)}' THEN ${getSqlLiteral(byId[id]?.comment ?? null)}`
    })
    .join(' ')
  await getAppDatabaseService().transaction(async (tx) => {
    const rows = await tx.queryJson<{id: string}>(`
      SELECT id
      FROM app.judgment_human
      WHERE id IN (${getQuotedStringList(idsToUpdate).join(', ')})
        AND project_id = '${escapeSqlString(body.projectId)}'
        AND is_answered = FALSE
    `)

    if (rows.length !== idsToUpdate.length) {
      throw new Error('One or more submitted answers could not be validated for update')
    }

    await tx.run(`
      UPDATE app.judgment_human
      SET answer = CASE ${answerCase} ELSE answer END,
          comment = CASE ${commentCase} ELSE comment END,
          is_answered = TRUE,
          updated_at = ${getSqlLiteral(updatedAt)}
      WHERE id IN (${getQuotedStringList(idsToUpdate).join(', ')})
        AND project_id = '${escapeSqlString(body.projectId)}'
        AND is_answered = FALSE
    `)

    await getProjectMartRefreshStateService().markProjectsDirtyAtomically({
      projects: [{articleIds: [currentArticleId], projectId: body.projectId}],
      reason: 'humanAssessmentRoutesPostSubmit',
      runner: tx,
    })
  })

  return {data: {updated: idsToUpdate.length}}
}
