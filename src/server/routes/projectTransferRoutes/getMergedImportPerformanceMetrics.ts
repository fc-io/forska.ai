import {
  getProjectTransferPerformanceMetrics,
  mergeProjectTransferPerformanceMetrics,
  type ProjectTransferPerformanceMetrics,
} from '../../services/projectTransfer/projectTransferPerformanceMetrics.ts'

const getDefaultImportPerformanceMetrics = () => {
  return getProjectTransferPerformanceMetrics({operation: 'import'})
}

export const getMergedImportPerformanceMetrics = (
  left: ProjectTransferPerformanceMetrics | null | undefined,
  right: ProjectTransferPerformanceMetrics | null | undefined,
) => {
  return mergeProjectTransferPerformanceMetrics(
    left ?? getDefaultImportPerformanceMetrics(),
    right ?? getDefaultImportPerformanceMetrics(),
  )
}
