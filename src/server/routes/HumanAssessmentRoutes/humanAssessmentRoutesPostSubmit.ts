import {type as arktype} from 'arktype'
import {and, eq, inArray, isNull, sql} from 'drizzle-orm'

import {auth} from '../../../auth.ts'
import {judgments, judgmentsHuman, prompts} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

export const humanAssessmentRoutesPostSubmit = async ({
  body,
  request,
  set,
}: {
  body: {projectId: string; answers: Array<{judgmentHumanId: string; answer: string; comment?: string}>}
  request: Request
  set: any
}) => {
  const db = getDatabase()
  const session = await auth.api.getSession({headers: request.headers})
  const sessionUserId = session?.user?.id ?? session?.session?.userId

  if (!sessionUserId) {
    set.status = 401
    return {data: null, error: 'You must be signed in to submit a human assessment'}
  }

  const pending = await db
    .select({
      id: judgmentsHuman.id,
      promptId: judgmentsHuman.promptId,
      articleId: judgmentsHuman.articleId,
      type: prompts.type,
    })
    .from(judgmentsHuman)
    .innerJoin(prompts, eq(judgmentsHuman.promptId, prompts.id))
    .where(
      and(
        eq(judgmentsHuman.projectId, body.projectId),
        eq(judgmentsHuman.user, sessionUserId),
        isNull(judgmentsHuman.answer),
      ),
    )

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
    const Type = arktype(typeStr)

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

  await db.transaction(async (tx) => {
    const rows = await tx
      .select({id: judgmentsHuman.id})
      .from(judgmentsHuman)
      .where(
        and(
          inArray(judgmentsHuman.id, idsToUpdate),
          eq(judgmentsHuman.user, sessionUserId),
          eq(judgmentsHuman.projectId, body.projectId),
          isNull(judgmentsHuman.answer),
        ),
      )

    if (rows.length !== idsToUpdate.length) {
      throw new Error('One or more submitted answers could not be validated for update')
    }

    for (const id of idsToUpdate) {
      const payload = byId[id]!
      await tx
        .update(judgmentsHuman)
        .set({answer: payload.answer, comment: payload.comment ?? null, updatedAt: new Date()})
        .where(
          and(
            eq(judgmentsHuman.id, id),
            eq(judgmentsHuman.user, sessionUserId),
            eq(judgmentsHuman.projectId, body.projectId),
          ),
        )
    }
  })

  return {data: {updated: idsToUpdate.length}}
}

