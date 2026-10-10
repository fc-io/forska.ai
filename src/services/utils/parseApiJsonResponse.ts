const isoTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/
const freeTextKeyPattern = /(?:comment|description|label|name|note|text|title)$/i

const getRevivedTimestamp = (value: string) => {
  const date = isoTimestampPattern.test(value) ? new Date(value) : null

  return date && !Number.isNaN(date.getTime()) ? date : value
}

export const reviveApiJsonValue = (key: string, value: unknown) => {
  return typeof value === 'string' && !freeTextKeyPattern.test(key) ? getRevivedTimestamp(value) : value
}

const getIsSuccessfulJsonResponse = (response: Response) => {
  return response.ok && response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() === 'application/json'
}

export const parseApiJsonResponse = async (response: Response): Promise<unknown> => {
  return getIsSuccessfulJsonResponse(response)
    ? (JSON.parse(await response.text(), reviveApiJsonValue) as unknown)
    : null
}
