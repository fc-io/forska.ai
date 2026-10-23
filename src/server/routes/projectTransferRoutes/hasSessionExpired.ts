import type {ProjectTransferSessionResponse} from '../../services/projectTransfer/projectTransferContracts.ts'

export const hasSessionExpired = (response: ProjectTransferSessionResponse, now: Date) => {
  return response.expiresAt.getTime() <= now.getTime()
}
