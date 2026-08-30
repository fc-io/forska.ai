type ReviewDetailUnavailableData = {article: null; reason?: string | null; status: 'unavailable'}
type ReviewDetailArchivedData = {article: null; code: 'PROJECT_ARCHIVED'; message?: string | null; status: 'archived'}

type ReviewDetailNotReadyData = ReviewDetailArchivedData | ReviewDetailUnavailableData

const isObjectRecord = (data: unknown): data is Record<string, unknown> => {
  return typeof data === 'object' && data !== null
}

export const isUnavailableReviewDetail = (data: unknown): data is ReviewDetailUnavailableData => {
  return isObjectRecord(data) && data.status === 'unavailable' && (data.article === null || data.article === undefined)
}

export const isArchivedReviewDetail = (data: unknown): data is ReviewDetailArchivedData => {
  return (
    isObjectRecord(data)
    && data.status === 'archived'
    && data.code === 'PROJECT_ARCHIVED'
    && (data.article === null || data.article === undefined)
  )
}

export const getArchivedReviewDetailFromResponseError = (error: unknown): ReviewDetailArchivedData | null => {
  const value = isObjectRecord(error) && isObjectRecord(error.value) ? error.value : null

  return isArchivedReviewDetail(value) ? value : null
}

export const getAvailableReviewDetail = <T,>(
  data: T | null | undefined,
): Exclude<T, ReviewDetailNotReadyData> | null => {
  return data && !isUnavailableReviewDetail(data) && !isArchivedReviewDetail(data)
    ? (data as Exclude<T, ReviewDetailNotReadyData>)
    : null
}

export const getReviewDetailUnavailableMessage = (data: ReviewDetailUnavailableData) => {
  const reason = typeof data.reason === 'string' && data.reason.trim().length > 0 ? data.reason.trim() : null
  return reason
    ? `Review details are unavailable while V4 review detail state catches up: ${reason}.`
    : 'Review details are unavailable while V4 review detail state catches up.'
}

export const ReviewDetailUnavailableState = (props: {data: ReviewDetailUnavailableData}) => {
  return (
    <div class="rounded-lg border border-amber-200 bg-amber-50 p-4 shadow">
      <h1 class="text-lg font-semibold text-amber-950">Review details unavailable</h1>
      <p class="mt-2 text-sm text-amber-900">{getReviewDetailUnavailableMessage(props.data)}</p>
      <p class="mt-2 text-xs text-amber-800">
        Article and judgment detail will load after the review-serving detail snapshot is ready.
      </p>
    </div>
  )
}

export const ReviewDetailArchivedState = (props: {data: ReviewDetailArchivedData}) => {
  const message = () => {
    return typeof props.data.message === 'string' && props.data.message.trim().length > 0
      ? props.data.message.trim()
      : 'Unarchive this project before reviewing articles.'
  }

  return (
    <div class="rounded-lg border border-gray-200 bg-white p-4 shadow">
      <h1 class="text-lg font-semibold text-gray-950">Archived project</h1>
      <p class="mt-2 text-sm text-gray-700">{message()}</p>
      <p class="mt-2 text-xs text-gray-500">
        Archived projects are read-only here. Move the project back to the active list to continue review work.
      </p>
    </div>
  )
}
