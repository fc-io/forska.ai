import type {DataSourceArticleChangeLogCursor} from '../../../services/dataSourceTrackingRepository.ts'

type TrackingChangeCursorPayload = {createdAt: string; detectedAt: string; id: string}

export const encodeTrackingChangeCursor = (row: {createdAt: Date; detectedAt: Date; id: string}): string => {
  const payload: TrackingChangeCursorPayload = {
    createdAt: row.createdAt.toISOString(),
    detectedAt: row.detectedAt.toISOString(),
    id: row.id,
  }

  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

export const decodeTrackingChangeCursor = (value: string | undefined): DataSourceArticleChangeLogCursor | null => {
  if (!value) {
    return null
  }

  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<TrackingChangeCursorPayload>
    if (!decoded.id || !decoded.createdAt || !decoded.detectedAt) {
      return null
    }

    const createdAt = new Date(decoded.createdAt)
    const detectedAt = new Date(decoded.detectedAt)
    if (Number.isNaN(createdAt.getTime()) || Number.isNaN(detectedAt.getTime())) {
      return null
    }

    return {createdAt, detectedAt, id: decoded.id}
  } catch {
    return null
  }
}
