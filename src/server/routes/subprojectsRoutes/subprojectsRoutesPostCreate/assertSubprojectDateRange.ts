import {HttpError} from '../../../utils/httpError.ts'

const subprojectDateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/u

const parseSubprojectDate = (value: string | undefined): Date | null => {
  if (value === undefined || value === '') {
    return null
  }

  const parsedDate = subprojectDateOnlyPattern.test(value) ? new Date(`${value}T00:00:00.000Z`) : new Date(Number.NaN)

  if (Number.isNaN(parsedDate.getTime())) {
    throw new HttpError(400, 'Invalid date value provided')
  }

  return parsedDate
}

// The client form already refuses a reversed range; the API has to refuse it too, because both
// bounds are applied as article filters and a reversed range creates a subproject with no articles.
export const assertSubprojectDateRange = ({dateFrom, dateTo}: {dateFrom?: string; dateTo?: string}) => {
  const parsedDateFrom = parseSubprojectDate(dateFrom)
  const parsedDateTo = parseSubprojectDate(dateTo)

  if (parsedDateFrom && parsedDateTo && parsedDateFrom.getTime() > parsedDateTo.getTime()) {
    throw new HttpError(400, 'date_from must be on or before date_to')
  }
}
