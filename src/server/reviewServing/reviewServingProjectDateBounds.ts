import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import type {ReviewServingReaderDatabase} from './reviewServingReader.ts'

type ProjectDateBounds = {dateFrom: string | null; dateTo: string | null}
type DateFilterCandidate = {date: Date; value: string}

const getDate = (value: unknown) => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value
  }

  if (typeof value !== 'string' && typeof value !== 'number') {
    return null
  }

  const date = new Date(value)

  return Number.isNaN(date.getTime()) ? null : date
}

const getDateFilterCandidate = (value: unknown): DateFilterCandidate | null => {
  const date = getDate(value)

  return date && typeof value === 'string' ? {date, value} : date ? {date, value: date.toISOString()} : null
}

const getLaterDate = (left: DateFilterCandidate | null, right: DateFilterCandidate | null) => {
  return left && right ? (left.date > right.date ? left : right) : (left ?? right)
}

const getEarlierDate = (left: DateFilterCandidate | null, right: DateFilterCandidate | null) => {
  return left && right ? (left.date < right.date ? left : right) : (left ?? right)
}

export const getEffectiveReviewServingDateFilters = async (
  params: {from?: string | null; projectId: string; to?: string | null},
  database: Pick<ReviewServingReaderDatabase, 'queryJson'> = getAppDatabaseService() as ReviewServingReaderDatabase,
) => {
  const [project] = await database.queryJson<ProjectDateBounds>(`
    SELECT date_from AS dateFrom, date_to AS dateTo
    FROM app.project
    WHERE id = ${getSqlLiteral(params.projectId)}
    LIMIT 1
  `)
  const from = getLaterDate(getDateFilterCandidate(project?.dateFrom), getDateFilterCandidate(params.from))
  const to = getEarlierDate(getDateFilterCandidate(project?.dateTo), getDateFilterCandidate(params.to))

  return {from: from?.value ?? null, to: to?.value ?? null}
}
