import * as appQueryHelpers from '../../../services/appQueryHelpers.ts'
import {appDatabaseService} from '../adminInvestigateRoutesServices.ts'
import {getProjectJudgmentClause} from '../getProjectJudgmentClause.ts'
import type {ProjectScope} from '../projectScope.ts'

type StringAnswerBucket = {value: string | null; count: number}
type ArrayAnswerBucket = {value: string | null; parsedValue: unknown; count: number}

export const getStringAnswerBuckets = async (
  promptId: string,
  projectScope: ProjectScope | null,
): Promise<StringAnswerBucket[]> => {
  const whereClause = appQueryHelpers.getAndClause([
    `j.prompt_id = '${appQueryHelpers.escapeSqlString(promptId)}'`,
    'j.deleted_at IS NULL',
    getProjectJudgmentClause(projectScope, 'j'),
  ])

  return appDatabaseService.queryJson<StringAnswerBucket>(`
    SELECT
      j.answered_original AS value,
      COUNT(*) AS count
    FROM app.judgment j
    WHERE ${whereClause}
    GROUP BY j.answered_original
  `)
}

export const getArrayAnswerBuckets = async (
  promptId: string,
  projectScope: ProjectScope | null,
): Promise<ArrayAnswerBucket[]> => {
  const whereClause = appQueryHelpers.getAndClause([
    `j.prompt_id = '${appQueryHelpers.escapeSqlString(promptId)}'`,
    'j.deleted_at IS NULL',
    getProjectJudgmentClause(projectScope, 'j'),
  ])
  const rows = await appDatabaseService.queryJson<{value: string | null; count: number}>(`
    SELECT
      TO_JSON(j.answered_original_as_array) AS value,
      COUNT(*) AS count
    FROM app.judgment j
    WHERE ${whereClause}
    GROUP BY j.answered_original_as_array
  `)

  return rows.map((row) => {
    return {value: row.value, parsedValue: appQueryHelpers.getJsonValue(row.value), count: row.count}
  })
}

export const getUnexpectedArrayAnswers = (buckets: ArrayAnswerBucket[], expectedOptions: string[]) => {
  return buckets
    .filter((bucket) => {
      if (bucket.parsedValue === null) return true
      if (!Array.isArray(bucket.parsedValue)) return true
      if (bucket.parsedValue.length === 0) return true
      return bucket.parsedValue.some((value) => {
        return typeof value !== 'string' || !expectedOptions.includes(value)
      })
    })
    .map((bucket) => {
      return {value: bucket.value, count: bucket.count}
    })
}

export const getUnexpectedStringAnswers = (buckets: StringAnswerBucket[], expectedOptions: string[]) => {
  return buckets.filter((bucket) => {
    if (bucket.value === null) return true
    if (bucket.value === '') return true
    return !expectedOptions.includes(bucket.value)
  })
}
