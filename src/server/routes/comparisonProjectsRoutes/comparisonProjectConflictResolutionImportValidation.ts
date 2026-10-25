import {HttpError} from '../../utils/httpError.ts'
import type {
  ComparisonProjectConflictResolutionImportMode,
  ComparisonProjectConflictResolutionImportOverwriteMode,
} from './comparisonProjectConflictResolutionImport/comparisonProjectConflictResolutionImportTypes.ts'

export const getConflictResolutionImportRejectedError = (message: string) => {
  return new HttpError(400, message)
}

export const getValidatedConflictResolutionImportMode = (
  value: unknown,
): ComparisonProjectConflictResolutionImportMode => {
  if (value === undefined || value === null) {
    return 'conflicting-only'
  }

  if (value === 'conflicting-only' || value === 'all-matched') {
    return value
  }

  throw getConflictResolutionImportRejectedError('Conflict resolution import mode is invalid')
}

export const getValidatedConflictResolutionImportOverwriteMode = (
  value: unknown,
): ComparisonProjectConflictResolutionImportOverwriteMode => {
  if (value === undefined || value === null) {
    return 'skip-existing'
  }

  if (value === 'skip-existing' || value === 'overwrite-different') {
    return value
  }

  throw getConflictResolutionImportRejectedError('Conflict resolution import overwrite mode is invalid')
}
