export const getReviewServingSourceTimestamp = (value: unknown) => {
  if (value instanceof Date) {
    return value.toISOString()
  }

  return typeof value === 'string' ? value : null
}
