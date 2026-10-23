import type {ProjectTransferApiResponse} from '../../services/projectTransfer/projectTransferContracts.ts'
import type {ProjectTransferImportSessionData} from './projectTransferRouteTypes.ts'
import {terminalImportSessionStates} from './terminalImportSessionStates.ts'

const staleActiveImportArtifactMaxAgeMs = 90 * 1000

export const shouldUseImportSessionArtifactResponse = (
  response: ProjectTransferApiResponse<ProjectTransferImportSessionData>,
  now = Date.now(),
) => {
  if (response.error !== null || response.data === null) {
    return false
  }

  if (terminalImportSessionStates.has(response.data.state)) {
    return true
  }

  const updatedAtMs = new Date(response.data.updatedAt).getTime()

  return !Number.isFinite(updatedAtMs) || now - updatedAtMs <= staleActiveImportArtifactMaxAgeMs
}
