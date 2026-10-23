import {createHash, randomUUID} from 'node:crypto'
import {createWriteStream} from 'node:fs'
import {mkdir, rename, rm, statfs} from 'node:fs/promises'
import {dirname} from 'node:path'

import {resolveProjectTransferTempWritablePath} from '../../../services/projectTransfer/projectTransferPaths.ts'
import {getProjectTransferImportTempLayout} from '../../../services/projectTransfer/projectTransferSession.ts'
import {writeRequestBodyArrayBuffer, writeRequestBodyChunks} from './writeImportUploadArtifact/writeRequestBody.ts'

const getUploadTempPathValue = ({ownerToken, sessionId}: {ownerToken: string; sessionId: string}) => {
  return `${getProjectTransferImportTempLayout(sessionId).rootPath}/upload.${ownerToken}.tmp`
}

const getAvailableDiskBytes = async (pathValue: string) => {
  const stats = await statfs(pathValue)

  return Number(stats.bavail) * Number(stats.bsize)
}

const getExpectedUploadContentLength = (request: Request) => {
  const headerValue = request.headers.get('content-length')

  if (headerValue === null) {
    return null
  }

  const byteLength = Number(headerValue)

  return Number.isSafeInteger(byteLength) && byteLength >= 0 ? byteLength : null
}

const assertUploadContentLength = ({
  expectedByteLength,
  actualByteLength,
}: {
  actualByteLength: number
  expectedByteLength: number | null
}) => {
  if (expectedByteLength === null || expectedByteLength === actualByteLength) {
    return
  }

  const error = new Error(
    `Project transfer upload ended after ${actualByteLength} bytes, expected ${expectedByteLength} bytes`,
  )
  error.name = 'ProjectTransferUploadContentLengthMismatchError'
  throw error
}

export const writeImportUploadArtifact = async ({
  fileName,
  request,
  sessionId,
}: {
  fileName: string
  request: Request
  sessionId: string
}) => {
  if (request.body === null) {
    return {error: 'Project transfer upload requires a request body', ok: false as const}
  }

  const layout = getProjectTransferImportTempLayout(sessionId)
  const ownerToken = randomUUID()
  const uploadPath = resolveProjectTransferTempWritablePath({pathValue: layout.uploadPath})
  const tempPath = resolveProjectTransferTempWritablePath({pathValue: getUploadTempPathValue({ownerToken, sessionId})})
  const hash = createHash('sha256')
  const expectedByteLength = getExpectedUploadContentLength(request)
  const state = {byteLength: 0}
  let writeSucceeded = false

  await mkdir(dirname(uploadPath), {recursive: true})
  const availableDiskBytes = await getAvailableDiskBytes(dirname(uploadPath))

  const fileStream = createWriteStream(tempPath)

  try {
    if (typeof request.body.getReader === 'function') {
      const reader = request.body.getReader()

      try {
        await writeRequestBodyChunks({
          availableDiskBytes,
          fileStream,
          hash,
          reader,
          state,
          tempRootPath: layout.rootPath,
        })
      } finally {
        if (typeof reader.releaseLock === 'function') {
          try {
            reader.releaseLock()
          } catch {
            // Bun's live HTTP body reader can throw here after a successful large streamed upload.
          }
        }
      }
    } else {
      await writeRequestBodyArrayBuffer({
        availableDiskBytes,
        fileStream,
        hash,
        request,
        state,
        tempRootPath: layout.rootPath,
      })
    }

    assertUploadContentLength({actualByteLength: state.byteLength, expectedByteLength})
    await rename(tempPath, uploadPath)
    writeSucceeded = true
  } finally {
    if (!writeSucceeded) {
      fileStream.destroy()
      await rm(tempPath, {force: true})
    }
  }

  return {metadata: {byteLength: state.byteLength, checksumSha256: hash.digest('hex'), fileName}, ok: true as const}
}
