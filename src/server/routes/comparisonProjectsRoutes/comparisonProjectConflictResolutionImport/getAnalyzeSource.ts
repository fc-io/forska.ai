import type {ComparisonProjectConflictResolutionTransferArtifact} from '../comparisonProjectConflictResolutionFileTransfer.ts'
import type {ComparisonProjectConflictResolutionImportAnalyzeSource} from './comparisonProjectConflictResolutionImportAnalyzeTypes.ts'

export const getAnalyzeSource = (
  artifact: ComparisonProjectConflictResolutionTransferArtifact,
): ComparisonProjectConflictResolutionImportAnalyzeSource => {
  return {
    comparisonProjectId: artifact.source.comparisonProjectId,
    comparisonProjectName: artifact.source.comparisonProjectName,
    comparisonProjectDescription: artifact.source.comparisonProjectDescription,
    exportedAt: artifact.exportedAt,
    format: artifact.format,
    version: artifact.version,
    rowCount: artifact.rows.length,
  }
}
