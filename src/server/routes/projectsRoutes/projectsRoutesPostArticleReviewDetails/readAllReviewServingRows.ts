import {readReviewServingRows} from '../../../reviewServing/reviewServingReader.ts'
import {detailReaderPageSize} from './detailReaderPageSize.ts'

type ReviewServingDetailRowsRequest = Parameters<typeof readReviewServingRows>[0]

export const readAllReviewServingRows = async <T>(
  request: ReviewServingDetailRowsRequest,
  cursor: string | null = null,
  previousRows: T[] = [],
): Promise<T[] | null> => {
  const result = await readReviewServingRows<T>({...request, cursor, limit: detailReaderPageSize})

  if (result.status === 'rejected') {
    return null
  }

  const rows = [...previousRows, ...result.rows]
  const lastRow = result.rows[result.rows.length - 1]
  const nextCursor =
    result.rows.length === detailReaderPageSize && lastRow
      ? result.getCursorForRow(lastRow as Record<string, unknown>)
      : null

  return nextCursor ? readAllReviewServingRows(request, nextCursor, rows) : rows
}
