import {
  getProjectTransferHistoryRepository,
  type ProjectTransferHistoryRunner,
} from './projectTransferHistoryRepository.ts'
import type {ProjectTransferPackageWarning} from './projectTransferSchemas.ts'

type ProjectTransferDuplicateDetectionInput = {
  limit?: number
  packageFingerprint: string | null
  runner?: ProjectTransferHistoryRunner
}

export type ProjectTransferDuplicateImportMatch = {
  createdAt: Date
  historyId: string
  sessionId: string | null
  targetProjectId: string | null
  targetProjectName: string | null
}

export type ProjectTransferDuplicateDetectionResult = {
  matches: ProjectTransferDuplicateImportMatch[]
  warnings: ProjectTransferPackageWarning[]
}

const getDuplicateImportWarning = (
  packageFingerprint: string,
  matches: ProjectTransferDuplicateImportMatch[],
): ProjectTransferPackageWarning[] => {
  return matches.length === 0
    ? []
    : [
        {
          action: 'warned',
          code: 'duplicateImportMatch',
          details: {matches, packageFingerprint},
          message: `${matches.length} completed import uses the same package fingerprint`,
          scope: 'manifest.packageFingerprint',
          severity: 'warning',
        },
      ]
}

export const getProjectTransferDuplicateImportDetection = async ({
  limit,
  packageFingerprint,
  runner,
}: ProjectTransferDuplicateDetectionInput): Promise<ProjectTransferDuplicateDetectionResult> => {
  if (packageFingerprint === null) {
    return {matches: [], warnings: []}
  }

  const rows = await getProjectTransferHistoryRepository().findDuplicateImportHistoryByPackageFingerprint({
    limit,
    packageFingerprint,
    runner,
  })
  const matches = rows.map((row) => {
    return {
      createdAt: row.createdAt,
      historyId: row.id,
      sessionId: row.sessionId,
      targetProjectId: row.targetProjectId,
      targetProjectName: row.targetProjectName,
    }
  })

  return {matches, warnings: getDuplicateImportWarning(packageFingerprint, matches)}
}
