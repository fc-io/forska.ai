import type {DuckdbWorkloadContext} from '../../utils/duckdbService.ts'

const projectTransferWorkloadClass = 'projectTransfer'

export const getProjectTransferWorkloadContext = ({
  allowsTempSpill = false,
  fallbackIntent = 'async',
  maxResultRows,
  projectId,
  routeOrJobKey,
}: Omit<DuckdbWorkloadContext, 'workloadClass'>): DuckdbWorkloadContext => {
  return {
    allowsTempSpill,
    fallbackIntent,
    maxResultRows,
    projectId,
    routeOrJobKey,
    workloadClass: projectTransferWorkloadClass,
  }
}

export const projectTransferRouteLookupWorkloadContext = getProjectTransferWorkloadContext({
  fallbackIntent: 'reject',
  maxResultRows: 1,
  routeOrJobKey: 'projectTransfer.route.sourceProjectLookup',
})

export const projectTransferExportWorkloadContext = getProjectTransferWorkloadContext({
  allowsTempSpill: true,
  routeOrJobKey: 'projectTransfer.export.queries',
})

export const projectTransferExportTransactionWorkloadContext = getProjectTransferWorkloadContext({
  allowsTempSpill: true,
  routeOrJobKey: 'projectTransfer.export.transaction',
})

export const projectTransferAnalyzeOperationWorkloadContext = getProjectTransferWorkloadContext({
  allowsTempSpill: true,
  routeOrJobKey: 'projectTransfer.import.analyze.operationTables',
})

export const projectTransferCommitTransactionWorkloadContext = getProjectTransferWorkloadContext({
  allowsTempSpill: true,
  routeOrJobKey: 'projectTransfer.import.commit.transaction',
})
