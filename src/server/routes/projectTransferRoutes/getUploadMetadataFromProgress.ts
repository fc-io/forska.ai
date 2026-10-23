import type {
  ProjectTransferProgressPayload,
  ProjectTransferUploadMetadataPayload,
} from '../../services/projectTransfer/projectTransferContracts.ts'
import {isRecord} from './projectTransferRequestBody.ts'

const isUploadMetadataPayload = (value: unknown): value is ProjectTransferUploadMetadataPayload => {
  return (
    isRecord(value)
    && typeof value.byteLength === 'number'
    && Number.isInteger(value.byteLength)
    && value.byteLength >= 0
    && typeof value.checksumSha256 === 'string'
    && typeof value.fileName === 'string'
  )
}

export const getUploadMetadataFromProgress = (
  progress: ProjectTransferProgressPayload | null,
): ProjectTransferUploadMetadataPayload | null => {
  return isUploadMetadataPayload(progress?.uploadMetadata) ? progress.uploadMetadata : null
}
