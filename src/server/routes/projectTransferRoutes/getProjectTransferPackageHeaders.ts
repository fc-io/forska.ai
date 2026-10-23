import type {ProjectTransferExportReadyPayload} from '../../services/projectTransfer/projectTransferContracts.ts'

type ProjectTransferPackageHeaderMetadata = Pick<
  ProjectTransferExportReadyPayload,
  'byteLength' | 'checksumSha256' | 'expiresAt' | 'filename' | 'packageFingerprint'
>

const getHeaderSafeFilename = (filename: string) => {
  const safeFilename = filename.replace(/[\r\n"\\;/]/g, '_').trim()

  return safeFilename === '' ? 'project-transfer-export.zip' : safeFilename
}

const getAttachmentContentDisposition = (filename: string) => {
  return `attachment; filename="${getHeaderSafeFilename(filename)}"`
}

export const getProjectTransferPackageHeaders = (metadata: ProjectTransferPackageHeaderMetadata) => {
  return {
    'content-disposition': getAttachmentContentDisposition(metadata.filename),
    'content-length': String(metadata.byteLength),
    'content-type': 'application/zip',
    'x-project-transfer-checksum-sha256': metadata.checksumSha256,
    'x-project-transfer-expires-at': metadata.expiresAt,
    'x-project-transfer-package-fingerprint': metadata.packageFingerprint,
  }
}
