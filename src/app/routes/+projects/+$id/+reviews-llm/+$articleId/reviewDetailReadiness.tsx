type ReviewDetailUnavailableData = {article?: null; reason?: string | null; status?: string}

export const isUnavailableReviewDetail = (data: unknown): data is ReviewDetailUnavailableData => {
  return (
    typeof data === 'object'
    && data !== null
    && (data as {status?: unknown}).status === 'unavailable'
    && ((data as {article?: unknown}).article === null || (data as {article?: unknown}).article === undefined)
  )
}

export const getAvailableReviewDetail = <T,>(data: T | null | undefined): T | null => {
  return data && !isUnavailableReviewDetail(data) ? data : null
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
