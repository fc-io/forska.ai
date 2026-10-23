import {HttpError} from '../../utils/httpError.ts'

export const getMaxInflightRequests = (value: number | null | undefined): number | null => {
  if (value === null || value === undefined) {
    return null
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new HttpError(400, 'maxInflightRequests must be null or a positive integer')
  }

  return value
}
