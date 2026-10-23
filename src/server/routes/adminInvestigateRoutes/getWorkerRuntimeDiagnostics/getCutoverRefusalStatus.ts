import type {DuckdbOwnerConnectionRecord} from '../../../utils/duckdbOwnerConnections.ts'
import {
  getRuntimeCutoverVersion,
  getRuntimeCutoverVersionMismatchMessage,
  isRuntimeCutoverVersionCompatible,
} from '../../../utils/runtimeCutover.ts'

const getCutoverRefusedPeer = (record: DuckdbOwnerConnectionRecord) => {
  return {
    connectionId: record.connectionId,
    instanceId: record.instanceId,
    message: getRuntimeCutoverVersionMismatchMessage({
      context: `worker registry process ${record.instanceId}`,
      runtimeVersion: record.runtimeVersion,
    }),
    runtimeVersion: record.runtimeVersion,
    serverRole: record.serverRole,
  }
}

export const getCutoverRefusalStatus = (records: DuckdbOwnerConnectionRecord[]) => {
  const refusedRegisteredProcesses = records
    .filter((record) => {
      return !isRuntimeCutoverVersionCompatible(record.runtimeVersion)
    })
    .map(getCutoverRefusedPeer)

  return {
    refusedRegisteredProcessCount: refusedRegisteredProcesses.length,
    refusedRegisteredProcesses,
    refusesIncompatiblePeers: true,
    refusesMissingRuntimeVersion: true,
    runtimeVersion: getRuntimeCutoverVersion(),
    status: refusedRegisteredProcesses.length > 0 ? 'refusing-incompatible-registry' : 'enforced',
  }
}
