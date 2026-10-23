import {HttpError} from '../../utils/httpError.ts'

export const getMaintenanceUnavailableError = (message: string, cause?: unknown) => {
  return new HttpError(503, `maintenance-unavailable: ${message}`, {cause})
}
