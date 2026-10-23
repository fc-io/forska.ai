import {createHash} from 'node:crypto'
import {type WriteStream} from 'node:fs'

import {validateProjectTransferResourceGates} from '../../../../services/projectTransfer/projectTransferContracts.ts'

const writeFileStreamChunk = (stream: WriteStream, chunk: Uint8Array) => {
  return new Promise<void>((resolve, reject) => {
    stream.write(chunk, (error) => {
      if (error) {
        reject(error)
        return
      }

      resolve()
    })
  })
}

const closeFileStream = (stream: WriteStream) => {
  return new Promise<void>((resolve, reject) => {
    stream.end((error?: Error | null) => {
      if (error) {
        reject(error)
        return
      }

      resolve()
    })
  })
}

export const writeRequestBodyChunks = async ({
  availableDiskBytes,
  fileStream,
  hash,
  reader,
  state,
  tempRootPath,
}: {
  availableDiskBytes: number
  fileStream: WriteStream
  hash: ReturnType<typeof createHash>
  reader: ReadableStreamDefaultReader<Uint8Array>
  state: {byteLength: number}
  tempRootPath: string
}): Promise<void> => {
  const next = await reader.read()

  if (next.done) {
    return closeFileStream(fileStream)
  }

  const nextByteLength = state.byteLength + next.value.byteLength

  assertUploadResourceGate({availableDiskBytes, byteLength: nextByteLength, tempRootPath})
  state.byteLength = nextByteLength
  hash.update(next.value)
  await writeFileStreamChunk(fileStream, next.value)

  return writeRequestBodyChunks({availableDiskBytes, fileStream, hash, reader, state, tempRootPath})
}

export const writeRequestBodyArrayBuffer = async ({
  availableDiskBytes,
  fileStream,
  hash,
  request,
  state,
  tempRootPath,
}: {
  availableDiskBytes: number
  fileStream: WriteStream
  hash: ReturnType<typeof createHash>
  request: Request
  state: {byteLength: number}
  tempRootPath: string
}) => {
  const bytes = new Uint8Array(await request.arrayBuffer())

  assertUploadResourceGate({availableDiskBytes, byteLength: bytes.byteLength, tempRootPath})
  state.byteLength = bytes.byteLength
  hash.update(bytes)
  await writeFileStreamChunk(fileStream, bytes)

  return closeFileStream(fileStream)
}

const getUploadResourceGateError = ({
  availableDiskBytes,
  byteLength,
  tempRootPath,
}: {
  availableDiskBytes: number
  byteLength: number
  tempRootPath: string
}) => {
  const validation = validateProjectTransferResourceGates({
    availableDiskBytes,
    fileBytes: byteLength,
    targetWriteBytes: byteLength,
    tempRootPath,
    usesStreamingParser: false,
    zipBytes: byteLength,
  })

  if (validation.ok) {
    return null
  }

  const error = new Error(`Project transfer upload ${validation.error}`)
  error.name = 'ProjectTransferUploadResourceGateError'

  return error
}

const assertUploadResourceGate = (input: {availableDiskBytes: number; byteLength: number; tempRootPath: string}) => {
  const error = getUploadResourceGateError(input)

  if (error !== null) {
    throw error
  }
}
