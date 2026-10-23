import type {ProjectTransferSessionResponse} from '../../services/projectTransfer/projectTransferContracts.ts'

export const terminalImportSessionStates = new Set<ProjectTransferSessionResponse['state']>([
  'cancelled',
  'completed',
  'expired',
  'failed',
])
