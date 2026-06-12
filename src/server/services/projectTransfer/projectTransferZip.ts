import {createHash} from 'node:crypto'
import {once} from 'node:events'
import {createReadStream, createWriteStream, type WriteStream} from 'node:fs'
import {mkdir, readFile} from 'node:fs/promises'
import {dirname} from 'node:path'
import {inflateRawSync} from 'node:zlib'

import {
  type ProjectTransferPathValidationError,
  validateProjectTransferArchiveMemberPaths,
} from './projectTransferPaths.ts'

export type ProjectTransferZipJsEntry = {
  compressedSize?: number
  directory?: boolean
  externalFileAttributes?: number
  filename: string
  getData: (writer: ProjectTransferZipJsUint8ArrayWriter) => Promise<unknown>
  signature?: number
  uncompressedSize?: number
  unixMode?: number
  zip64?: boolean
}

export type ProjectTransferZipJsUint8ArrayWriter = {getData: () => Promise<Uint8Array> | Uint8Array}

export type ProjectTransferZipJsModule = {
  Uint8ArrayReader: new (bytes: Uint8Array) => unknown
  Uint8ArrayWriter: new () => ProjectTransferZipJsUint8ArrayWriter
  ZipReader: new (
    reader: unknown,
    options?: Record<string, unknown>,
  ) => {close: () => Promise<void>; getEntries: () => Promise<ProjectTransferZipJsEntry[]>}
  ZipWriter: new (
    writer: unknown,
    options?: Record<string, unknown>,
  ) => {
    add: (pathValue: string, reader: unknown, options?: Record<string, unknown>) => Promise<void>
    close: (options?: Record<string, unknown>) => Promise<Uint8Array>
  }
}

export type ProjectTransferZipEntryMetadata = {checksumSha256: string; crc32: number; uncompressedSize: number}

type ProjectTransferZipEntryStream = AsyncIterable<unknown> | Iterable<unknown>
type ProjectTransferZipEntryStreamFactory = () => Promise<ProjectTransferZipEntryStream> | ProjectTransferZipEntryStream

export type ProjectTransferZipEntryInput =
  | {
      bytes: string | Uint8Array
      filePath?: never
      lastModifiedAt?: Date
      metadata?: ProjectTransferZipEntryMetadata
      path: string
      stream?: never
    }
  | {
      bytes?: never
      filePath: string
      lastModifiedAt?: Date
      metadata?: ProjectTransferZipEntryMetadata
      path: string
      stream?: never
    }
  | {
      bytes?: never
      filePath?: never
      lastModifiedAt?: Date
      metadata: ProjectTransferZipEntryMetadata
      path: string
      stream: ProjectTransferZipEntryStreamFactory
    }

export type ProjectTransferZipEntryDigest = {
  advisoryCompressedSize: number | null
  advisoryCrc32: number | null
  advisoryUncompressedSize: number | null
  checksumSha256: string
  compressedSize: number | null
  path: string
  uncompressedSize: number
  zip64: boolean
}

export type ProjectTransferZipReadEntry = ProjectTransferZipEntryDigest & {bytes: Uint8Array}

export type ProjectTransferZipReadPackage = {
  entries: ProjectTransferZipReadEntry[]
  manifest: ProjectTransferZipReadEntry
}

export type ProjectTransferZipWrittenPackage = {
  bytes: Uint8Array
  checksumSha256: string
  entries: ProjectTransferZipEntryDigest[]
  uncompressedSize: number
}

export type ProjectTransferZipWrittenFilePackage = {
  byteLength: number
  checksumSha256: string
  entries: ProjectTransferZipEntryDigest[]
  uncompressedSize: number
}

type ProjectTransferZipReadOptions = {
  beforeReadEntries?: (entries: readonly ProjectTransferZipJsEntry[]) => void
  bytes: Uint8Array
  zipModule?: ProjectTransferZipJsModule
}

type ProjectTransferZipWriteOptions = {
  entries: readonly ProjectTransferZipEntryInput[]
  zipModule?: ProjectTransferZipJsModule
}

type ProjectTransferZipWriteToFileOptions = {entries: readonly ProjectTransferZipEntryInput[]; outputPath: string}

type ProjectTransferZipOutput = {getByteLength: () => number; writeBytes: (bytes: Uint8Array) => Promise<void>}

type ProjectTransferZipFileEntry = ProjectTransferZipEntryDigest & {
  compressedSize: number
  filenameBytes: Uint8Array
  localHeaderOffset: number
}

type ProjectTransferZipCentralDirectoryEntry = {
  compressedSize: number
  compressionMethod: number
  externalFileAttributes: number
  localHeaderOffset: number
  path: string
  signature: number
  uncompressedSize: number
  unixMode: number | null
  zip64: boolean
}

type ProjectTransferZipEnd = {centralDirectoryOffset: number; centralDirectorySize: number; entryCount: number}

type ProjectTransferZipEntrySource = ProjectTransferZipEntryMetadata & {bytes?: Uint8Array}

const projectTransferManifestPath = 'manifest.json'
const projectTransferZipDefaultLastModifiedAt = new Date('1980-01-01T00:00:00.000Z')
const unixFileTypeMask = 0o170000
const unixSymlinkFileType = 0o120000
const unixDirectoryFileType = 0o040000
const zipUtf8Flag = 0x0800
const zipEncryptedFlag = 0x0001
const zipStoreCompressionMethod = 0
const zipDeflateCompressionMethod = 8
const zipVersionMadeBy = 45
const zipVersionNeeded = 45
const zipDosTime = 0
const zipDosDate = 33
const zipUint16Max = 0xffff
const zipUint32Max = 0xffffffff
const zip64ExtraFieldHeaderId = 0x0001
const zipLocalFileHeaderSignature = 0x04034b50
const zipCentralDirectoryHeaderSignature = 0x02014b50
const zipEndOfCentralDirectorySignature = 0x06054b50
const zip64EndOfCentralDirectorySignature = 0x06064b50
const zip64EndOfCentralDirectoryLocatorSignature = 0x07064b50
const zipEndOfCentralDirectoryLength = 22
const zip64EndOfCentralDirectoryLocatorLength = 20
const zipEndOfCentralDirectoryMaxCommentLength = 0xffff
const projectTransferZipTextDecoder = new TextDecoder()

const getPathErrorMessage = (error: ProjectTransferPathValidationError) => {
  return error.conflictingPath
    ? `${error.message}: ${error.path} conflicts with ${error.conflictingPath}`
    : `${error.message}: ${error.path}`
}

const throwProjectTransferZipError = (code: string, message: string): never => {
  throw new Error(`Project transfer zip ${code}: ${message}`)
}

const assertProjectTransferZipRange = ({
  byteLength,
  context,
  offset,
  size,
}: {
  byteLength: number
  context: string
  offset: number
  size: number
}) => {
  const end = offset + size

  if (
    !Number.isSafeInteger(offset)
    || !Number.isSafeInteger(size)
    || offset < 0
    || size < 0
    || !Number.isSafeInteger(end)
    || end > byteLength
  ) {
    return throwProjectTransferZipError('malformed_archive', `${context} is outside the archive bounds`)
  }

  return undefined
}

const getProjectTransferZipView = (bytes: Uint8Array) => {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

const assertProjectTransferZipViewRange = (view: DataView, offset: number, size: number, context: string) => {
  return assertProjectTransferZipRange({byteLength: view.byteLength, context, offset, size})
}

const getProjectTransferZipUint16 = (view: DataView, offset: number, context: string) => {
  assertProjectTransferZipViewRange(view, offset, 2, context)
  return view.getUint16(offset, true)
}

const getProjectTransferZipUint32 = (view: DataView, offset: number, context: string) => {
  assertProjectTransferZipViewRange(view, offset, 4, context)
  return view.getUint32(offset, true)
}

const getSafeProjectTransferZipNumber = (value: bigint, context: string) => {
  const numberValue = Number(value)

  return Number.isSafeInteger(numberValue)
    ? numberValue
    : throwProjectTransferZipError('zip64_value_too_large', `${context} is too large`)
}

const getProjectTransferZipUint64 = (view: DataView, offset: number, context: string) => {
  assertProjectTransferZipViewRange(view, offset, 8, context)
  return getSafeProjectTransferZipNumber(view.getBigUint64(offset, true), context)
}

const getProjectTransferZipBytesSlice = (bytes: Uint8Array, offset: number, size: number, context: string) => {
  assertProjectTransferZipRange({byteLength: bytes.byteLength, context, offset, size})
  return bytes.slice(offset, offset + size)
}

const assertProjectTransferZipPaths = (paths: readonly string[]) => {
  const pathResult = validateProjectTransferArchiveMemberPaths({paths})

  if (!pathResult.ok) {
    return throwProjectTransferZipError(`path_${pathResult.error.code}`, getPathErrorMessage(pathResult.error))
  }

  return pathResult.value
}

const getNumberOrNull = (value: number | undefined) => {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const getProjectTransferZipEntryUnixMode = (entry: ProjectTransferZipJsEntry) => {
  const unixMode = getNumberOrNull(entry.unixMode)
  const externalFileAttributes = getNumberOrNull(entry.externalFileAttributes)

  return unixMode ?? (externalFileAttributes === null ? null : externalFileAttributes >>> 16)
}

const isProjectTransferZipSymlinkEntry = (entry: ProjectTransferZipJsEntry) => {
  const unixMode = getProjectTransferZipEntryUnixMode(entry)

  return unixMode !== null && (unixMode & unixFileTypeMask) === unixSymlinkFileType
}

const assertProjectTransferZipEntryMetadata = (entries: readonly ProjectTransferZipJsEntry[]) => {
  const directoryEntry = entries.find((entry) => {
    return entry.directory === true
  })

  if (directoryEntry) {
    return throwProjectTransferZipError(
      'directory_entry',
      `Directory entries are not supported: ${directoryEntry.filename}`,
    )
  }

  const symlinkEntry = entries.find(isProjectTransferZipSymlinkEntry)

  return symlinkEntry
    ? throwProjectTransferZipError('symlink_entry', `Symlink entries are not supported: ${symlinkEntry.filename}`)
    : undefined
}

const assertProjectTransferZipHasManifest = <TEntry extends {path: string}>(entries: readonly TEntry[]) => {
  const manifest = entries.find((entry) => {
    return entry.path === projectTransferManifestPath
  })

  return manifest ?? throwProjectTransferZipError('missing_manifest', 'manifest.json must exist at the archive root')
}

const getBytes = (bytes: string | Uint8Array) => {
  return typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes
}

const getSha256Digest = (bytes: Uint8Array) => {
  return createHash('sha256').update(bytes).digest('hex')
}

const isProjectTransferZipFileInput = (
  entry: ProjectTransferZipEntryInput,
): entry is Extract<ProjectTransferZipEntryInput, {filePath: string}> => {
  return 'filePath' in entry && typeof entry.filePath === 'string'
}

const isProjectTransferZipStreamInput = (
  entry: ProjectTransferZipEntryInput,
): entry is Extract<ProjectTransferZipEntryInput, {stream: ProjectTransferZipEntryStreamFactory}> => {
  return 'stream' in entry && typeof entry.stream === 'function'
}

const getProjectTransferZipBytesSource = (bytes: Uint8Array): ProjectTransferZipEntrySource => {
  return {
    bytes,
    checksumSha256: getSha256Digest(bytes),
    crc32: getProjectTransferZipCrc32Digest(bytes),
    uncompressedSize: bytes.byteLength,
  }
}

const getProjectTransferZipFileSource = async (filePath: string): Promise<ProjectTransferZipEntrySource> => {
  const hash = createHash('sha256')
  const state = {crc32: getProjectTransferZipInitialCrc32(), uncompressedSize: 0}

  for await (const chunk of createReadStream(filePath)) {
    const bytes = getProjectTransferZipEntryBytes(chunk)

    if (bytes) {
      hash.update(bytes)
      state.uncompressedSize += bytes.byteLength
      state.crc32 = getProjectTransferZipUpdatedCrc32(bytes, state.crc32)
    }
  }

  return {
    checksumSha256: hash.digest('hex'),
    crc32: getProjectTransferZipFinalCrc32(state.crc32),
    uncompressedSize: state.uncompressedSize,
  }
}

const assertProjectTransferZipEntrySourceMetadata = (entry: ProjectTransferZipEntryInput) => {
  const metadata = entry.metadata

  if (!metadata) {
    return undefined
  }

  if (!Number.isSafeInteger(metadata.uncompressedSize) || metadata.uncompressedSize < 0) {
    return throwProjectTransferZipError('entry_metadata', `Invalid uncompressed size for ${entry.path}`)
  }

  if (!Number.isInteger(metadata.crc32) || metadata.crc32 < 0 || metadata.crc32 > zipUint32Max) {
    return throwProjectTransferZipError('entry_metadata', `Invalid CRC32 for ${entry.path}`)
  }

  return /^[a-f0-9]{64}$/.test(metadata.checksumSha256)
    ? undefined
    : throwProjectTransferZipError('entry_metadata', `Invalid checksum for ${entry.path}`)
}

const getProjectTransferZipEntrySourceMetadata = async (
  entry: ProjectTransferZipEntryInput,
): Promise<ProjectTransferZipEntryMetadata> => {
  assertProjectTransferZipEntrySourceMetadata(entry)

  if (entry.metadata) {
    return entry.metadata
  }

  return isProjectTransferZipFileInput(entry)
    ? getProjectTransferZipFileSource(entry.filePath)
    : getProjectTransferZipBytesSource(getBytes(entry.bytes))
}

const getProjectTransferZipSourceChunkBytes = (value: unknown) => {
  const bytes = getProjectTransferZipEntryBytes(value)

  return bytes ?? (typeof value === 'string' ? getBytes(value) : null)
}

const readProjectTransferZipEntrySourceBytes = async (source: ProjectTransferZipEntryStream) => {
  const chunks: Uint8Array[] = []
  const state = {uncompressedSize: 0}

  for await (const chunk of source) {
    const bytes = getProjectTransferZipSourceChunkBytes(chunk)

    if (!bytes) {
      return throwProjectTransferZipError('entry_data', 'Entry stream emitted unsupported data')
    }

    chunks.push(bytes)
    state.uncompressedSize += bytes.byteLength
  }

  return new Uint8Array(
    Buffer.concat(
      chunks.map((chunk) => {
        return Buffer.from(chunk)
      }),
      state.uncompressedSize,
    ),
  )
}

const readProjectTransferZipInputBytes = async (entry: ProjectTransferZipEntryInput) => {
  if (isProjectTransferZipFileInput(entry)) {
    return new Uint8Array(await readFile(entry.filePath))
  }

  return isProjectTransferZipStreamInput(entry)
    ? readProjectTransferZipEntrySourceBytes(await entry.stream())
    : getBytes(entry.bytes)
}

const getProjectTransferZipEntryWriteState = () => {
  return {hash: createHash('sha256'), crc32: getProjectTransferZipInitialCrc32(), uncompressedSize: 0}
}

const updateProjectTransferZipEntryWriteState = (
  state: ReturnType<typeof getProjectTransferZipEntryWriteState>,
  bytes: Uint8Array,
) => {
  state.hash.update(bytes)
  state.crc32 = getProjectTransferZipUpdatedCrc32(bytes, state.crc32)
  state.uncompressedSize += bytes.byteLength

  return state
}

const getProjectTransferZipEntryWrittenMetadata = (state: ReturnType<typeof getProjectTransferZipEntryWriteState>) => {
  return {
    checksumSha256: state.hash.digest('hex'),
    crc32: getProjectTransferZipFinalCrc32(state.crc32),
    uncompressedSize: state.uncompressedSize,
  }
}

const assertProjectTransferZipWrittenMetadata = ({
  expected,
  path,
  written,
}: {
  expected: ProjectTransferZipEntryMetadata
  path: string
  written: ProjectTransferZipEntryMetadata
}) => {
  return expected.uncompressedSize === written.uncompressedSize
    && expected.crc32 === written.crc32
    && expected.checksumSha256 === written.checksumSha256
    ? undefined
    : throwProjectTransferZipError('entry_metadata_mismatch', `Entry metadata does not match written bytes for ${path}`)
}

const writeProjectTransferZipSourceBytesToOutput = async (
  bytes: Uint8Array,
  output: ProjectTransferZipOutput,
  state: ReturnType<typeof getProjectTransferZipEntryWriteState>,
) => {
  updateProjectTransferZipEntryWriteState(state, bytes)
  await output.writeBytes(bytes)
}

const writeProjectTransferZipIterableSourceToOutput = async (
  source: ProjectTransferZipEntryStream,
  output: ProjectTransferZipOutput,
  state: ReturnType<typeof getProjectTransferZipEntryWriteState>,
) => {
  for await (const chunk of source) {
    const bytes = getProjectTransferZipSourceChunkBytes(chunk)

    if (!bytes) {
      return throwProjectTransferZipError('entry_data', 'Entry stream emitted unsupported data')
    }

    await writeProjectTransferZipSourceBytesToOutput(bytes, output, state)
  }

  return undefined
}

const writeProjectTransferZipEntrySourceToOutput = async (
  entry: ProjectTransferZipEntryInput,
  metadata: ProjectTransferZipEntryMetadata,
  output: ProjectTransferZipOutput,
) => {
  const state = getProjectTransferZipEntryWriteState()

  if (isProjectTransferZipFileInput(entry)) {
    await writeProjectTransferZipIterableSourceToOutput(createReadStream(entry.filePath), output, state)
  } else if (isProjectTransferZipStreamInput(entry)) {
    await writeProjectTransferZipIterableSourceToOutput(await entry.stream(), output, state)
  } else {
    await writeProjectTransferZipSourceBytesToOutput(getBytes(entry.bytes), output, state)
  }

  const written = getProjectTransferZipEntryWrittenMetadata(state)

  assertProjectTransferZipWrittenMetadata({expected: metadata, path: entry.path, written})

  return written
}

const getCrc32Table = () => {
  return Array.from({length: 256}, (_, index) => {
    return (
      Array.from({length: 8}).reduce((crc) => {
        return (crc & 1) === 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
      }, index) >>> 0
    )
  })
}

const crc32Table = getCrc32Table()

export const getProjectTransferZipInitialCrc32 = () => {
  return 0xffffffff
}

export const getProjectTransferZipFinalCrc32 = (crc32: number) => {
  return (crc32 ^ 0xffffffff) >>> 0
}

export const getProjectTransferZipUpdatedCrc32 = (bytes: Uint8Array, previousCrc: number) => {
  return bytes.reduce((crc, byte) => {
    return (crc >>> 8) ^ (crc32Table[(crc ^ byte) & 0xff] ?? 0)
  }, previousCrc)
}

export const getProjectTransferZipCrc32Digest = (bytes: Uint8Array) => {
  return getProjectTransferZipFinalCrc32(getProjectTransferZipUpdatedCrc32(bytes, getProjectTransferZipInitialCrc32()))
}

const getNumberZip32 = (value: number) => {
  return value > zipUint32Max ? zipUint32Max : value
}

const setUint64 = (view: DataView, offset: number, value: number) => {
  view.setBigUint64(offset, BigInt(value), true)
}

const createBytes = (byteLength: number, write: (view: DataView) => void) => {
  const bytes = new Uint8Array(byteLength)
  write(new DataView(bytes.buffer))
  return bytes
}

const createZip64ExtraField = (values: readonly number[]) => {
  return createBytes(4 + values.length * 8, (view) => {
    view.setUint16(0, zip64ExtraFieldHeaderId, true)
    view.setUint16(2, values.length * 8, true)
    values.map((value, index) => {
      setUint64(view, 4 + index * 8, value)
      return value
    })
  })
}

const getZipLocalFileHeader = ({
  crc32,
  filenameBytes,
  size,
}: {
  crc32: number
  filenameBytes: Uint8Array
  size: number
}) => {
  const extraField = size > zipUint32Max ? createZip64ExtraField([size, size]) : new Uint8Array()

  return {
    extraField,
    header: createBytes(30, (view) => {
      view.setUint32(0, 0x04034b50, true)
      view.setUint16(4, size > zipUint32Max ? zipVersionNeeded : 20, true)
      view.setUint16(6, zipUtf8Flag, true)
      view.setUint16(8, zipStoreCompressionMethod, true)
      view.setUint16(10, zipDosTime, true)
      view.setUint16(12, zipDosDate, true)
      view.setUint32(14, crc32, true)
      view.setUint32(18, getNumberZip32(size), true)
      view.setUint32(22, getNumberZip32(size), true)
      view.setUint16(26, filenameBytes.byteLength, true)
      view.setUint16(28, extraField.byteLength, true)
    }),
  }
}

const getZipCentralDirectoryHeader = (entry: ProjectTransferZipFileEntry) => {
  const zip64Values = [entry.uncompressedSize, entry.compressedSize, entry.localHeaderOffset].filter((value) => {
    return value > zipUint32Max
  })
  const extraField = zip64Values.length > 0 ? createZip64ExtraField(zip64Values) : new Uint8Array()

  return {
    extraField,
    header: createBytes(46, (view) => {
      view.setUint32(0, 0x02014b50, true)
      view.setUint16(4, zipVersionMadeBy, true)
      view.setUint16(6, zip64Values.length > 0 ? zipVersionNeeded : 20, true)
      view.setUint16(8, zipUtf8Flag, true)
      view.setUint16(10, zipStoreCompressionMethod, true)
      view.setUint16(12, zipDosTime, true)
      view.setUint16(14, zipDosDate, true)
      view.setUint32(16, entry.advisoryCrc32 ?? 0, true)
      view.setUint32(20, getNumberZip32(entry.compressedSize), true)
      view.setUint32(24, getNumberZip32(entry.uncompressedSize), true)
      view.setUint16(28, entry.filenameBytes.byteLength, true)
      view.setUint16(30, extraField.byteLength, true)
      view.setUint16(32, 0, true)
      view.setUint16(34, 0, true)
      view.setUint16(36, 0, true)
      view.setUint32(38, 0, true)
      view.setUint32(42, getNumberZip32(entry.localHeaderOffset), true)
    }),
  }
}

const isZip64EndRequired = ({
  centralDirectoryOffset,
  centralDirectorySize,
  entryCount,
}: {
  centralDirectoryOffset: number
  centralDirectorySize: number
  entryCount: number
}) => {
  return entryCount > zipUint16Max || centralDirectoryOffset > zipUint32Max || centralDirectorySize > zipUint32Max
}

const getZip64EndOfCentralDirectory = ({
  centralDirectoryOffset,
  centralDirectorySize,
  entryCount,
}: {
  centralDirectoryOffset: number
  centralDirectorySize: number
  entryCount: number
}) => {
  return createBytes(56, (view) => {
    view.setUint32(0, 0x06064b50, true)
    setUint64(view, 4, 44)
    view.setUint16(12, zipVersionMadeBy, true)
    view.setUint16(14, zipVersionNeeded, true)
    view.setUint32(16, 0, true)
    view.setUint32(20, 0, true)
    setUint64(view, 24, entryCount)
    setUint64(view, 32, entryCount)
    setUint64(view, 40, centralDirectorySize)
    setUint64(view, 48, centralDirectoryOffset)
  })
}

const getZip64EndOfCentralDirectoryLocator = (zip64EndOffset: number) => {
  return createBytes(20, (view) => {
    view.setUint32(0, 0x07064b50, true)
    view.setUint32(4, 0, true)
    setUint64(view, 8, zip64EndOffset)
    view.setUint32(16, 1, true)
  })
}

const getZipEndOfCentralDirectory = ({
  centralDirectoryOffset,
  centralDirectorySize,
  entryCount,
  zip64,
}: {
  centralDirectoryOffset: number
  centralDirectorySize: number
  entryCount: number
  zip64: boolean
}) => {
  return createBytes(22, (view) => {
    view.setUint32(0, 0x06054b50, true)
    view.setUint16(4, 0, true)
    view.setUint16(6, 0, true)
    view.setUint16(8, zip64 ? zipUint16Max : entryCount, true)
    view.setUint16(10, zip64 ? zipUint16Max : entryCount, true)
    view.setUint32(12, zip64 ? zipUint32Max : centralDirectorySize, true)
    view.setUint32(16, zip64 ? zipUint32Max : centralDirectoryOffset, true)
    view.setUint16(20, 0, true)
  })
}

const writeStreamBytes = async (stream: WriteStream, bytes: Uint8Array) => {
  if (bytes.byteLength === 0) {
    return
  }

  if (!stream.write(bytes)) {
    await once(stream, 'drain')
  }
}

const closeWriteStream = async (stream: WriteStream) => {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      reject(error)
    }
    stream.once('error', onError)
    stream.end(() => {
      stream.off('error', onError)
      resolve()
    })
  })
}

const getProjectTransferZipEntryBytes = (value: unknown) => {
  if (value instanceof Uint8Array) {
    return value
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value)
  }

  return ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : null
}

const readProjectTransferZipWriterBytes = async ({
  data,
  writer,
}: {
  data: unknown
  writer: ProjectTransferZipJsUint8ArrayWriter
}) => {
  const returnedBytes = getProjectTransferZipEntryBytes(data)

  if (returnedBytes) {
    return returnedBytes
  }

  const writerBytes = getProjectTransferZipEntryBytes(await writer.getData())

  return writerBytes ?? throwProjectTransferZipError('entry_data', 'Entry data writer did not return bytes')
}

const readProjectTransferZipEntryData = async (
  entry: ProjectTransferZipJsEntry,
  zipModule: ProjectTransferZipJsModule,
): Promise<ProjectTransferZipReadEntry> => {
  const writer = new zipModule.Uint8ArrayWriter()
  const bytes = await readProjectTransferZipWriterBytes({data: await entry.getData(writer), writer})

  return {
    advisoryCompressedSize: getNumberOrNull(entry.compressedSize),
    advisoryCrc32: getNumberOrNull(entry.signature),
    advisoryUncompressedSize: getNumberOrNull(entry.uncompressedSize),
    bytes,
    checksumSha256: getSha256Digest(bytes),
    compressedSize: getNumberOrNull(entry.compressedSize),
    path: entry.filename,
    uncompressedSize: bytes.byteLength,
    zip64: entry.zip64 === true,
  }
}

const writeProjectTransferZipEntry = async (
  zipWriter: InstanceType<ProjectTransferZipJsModule['ZipWriter']>,
  zipModule: ProjectTransferZipJsModule,
  entry: ProjectTransferZipEntryInput,
): Promise<ProjectTransferZipEntryDigest> => {
  const bytes = await readProjectTransferZipInputBytes(entry)

  await zipWriter.add(entry.path, new zipModule.Uint8ArrayReader(bytes), {
    lastModDate: entry.lastModifiedAt ?? projectTransferZipDefaultLastModifiedAt,
  })

  return {
    advisoryCompressedSize: null,
    advisoryCrc32: null,
    advisoryUncompressedSize: null,
    checksumSha256: getSha256Digest(bytes),
    compressedSize: null,
    path: entry.path,
    uncompressedSize: bytes.byteLength,
    zip64: false,
  }
}

const writeProjectTransferZipEntries = async (
  zipWriter: InstanceType<ProjectTransferZipJsModule['ZipWriter']>,
  zipModule: ProjectTransferZipJsModule,
  entries: readonly ProjectTransferZipEntryInput[],
) => {
  return entries.reduce<Promise<ProjectTransferZipEntryDigest[]>>(async (previousEntries, entry) => {
    const writtenEntries = await previousEntries
    const writtenEntry = await writeProjectTransferZipEntry(zipWriter, zipModule, entry)

    return [...writtenEntries, writtenEntry]
  }, Promise.resolve([]))
}

const writeProjectTransferZipEntriesToOutput = async (
  entries: readonly ProjectTransferZipEntryInput[],
  output: ProjectTransferZipOutput,
) => {
  return entries.reduce<Promise<ProjectTransferZipFileEntry[]>>(async (previousEntries, entry) => {
    const currentEntries = await previousEntries
    const metadata = await getProjectTransferZipEntrySourceMetadata(entry)
    const filenameBytes = new TextEncoder().encode(entry.path)
    const localHeaderOffset = output.getByteLength()
    const {extraField, header} = getZipLocalFileHeader({
      crc32: metadata.crc32,
      filenameBytes,
      size: metadata.uncompressedSize,
    })

    await output.writeBytes(header)
    await output.writeBytes(filenameBytes)
    await output.writeBytes(extraField)
    const written = await writeProjectTransferZipEntrySourceToOutput(entry, metadata, output)

    return [
      ...currentEntries,
      {
        advisoryCompressedSize: written.uncompressedSize,
        advisoryCrc32: written.crc32,
        advisoryUncompressedSize: written.uncompressedSize,
        checksumSha256: written.checksumSha256,
        compressedSize: written.uncompressedSize,
        filenameBytes,
        localHeaderOffset,
        path: entry.path,
        uncompressedSize: written.uncompressedSize,
        zip64: written.uncompressedSize > zipUint32Max || localHeaderOffset > zipUint32Max,
      },
    ]
  }, Promise.resolve([]))
}

const writeProjectTransferZipCentralDirectoryToOutput = async (
  writtenEntries: readonly ProjectTransferZipFileEntry[],
  output: ProjectTransferZipOutput,
) => {
  const centralDirectoryOffset = output.getByteLength()

  await writtenEntries.reduce<Promise<void>>(async (previous, entry) => {
    await previous
    const {extraField, header} = getZipCentralDirectoryHeader(entry)
    await output.writeBytes(header)
    await output.writeBytes(entry.filenameBytes)
    await output.writeBytes(extraField)
  }, Promise.resolve())

  return {centralDirectoryOffset, centralDirectorySize: output.getByteLength() - centralDirectoryOffset}
}

const writeProjectTransferZipEndToOutput = async ({
  centralDirectoryOffset,
  centralDirectorySize,
  entryCount,
  output,
  zip64,
}: {
  centralDirectoryOffset: number
  centralDirectorySize: number
  entryCount: number
  output: ProjectTransferZipOutput
  zip64: boolean
}) => {
  if (zip64) {
    const zip64EndOffset = output.getByteLength()
    await output.writeBytes(getZip64EndOfCentralDirectory({centralDirectoryOffset, centralDirectorySize, entryCount}))
    await output.writeBytes(getZip64EndOfCentralDirectoryLocator(zip64EndOffset))
  }

  return output.writeBytes(
    getZipEndOfCentralDirectory({centralDirectoryOffset, centralDirectorySize, entryCount, zip64}),
  )
}

const writeProjectTransferZipContentToOutput = async (
  entries: readonly ProjectTransferZipEntryInput[],
  output: ProjectTransferZipOutput,
) => {
  const writtenEntries = await writeProjectTransferZipEntriesToOutput(entries, output)
  const {centralDirectoryOffset, centralDirectorySize} = await writeProjectTransferZipCentralDirectoryToOutput(
    writtenEntries,
    output,
  )
  const zip64 =
    isZip64EndRequired({centralDirectoryOffset, centralDirectorySize, entryCount: writtenEntries.length})
    || writtenEntries.some((entry) => {
      return entry.zip64
    })

  await writeProjectTransferZipEndToOutput({
    centralDirectoryOffset,
    centralDirectorySize,
    entryCount: writtenEntries.length,
    output,
    zip64,
  })

  return writtenEntries
}

const writeProjectTransferStoredZipPackage = async (
  entries: readonly ProjectTransferZipEntryInput[],
): Promise<ProjectTransferZipWrittenPackage> => {
  const archiveHash = createHash('sha256')
  const chunks: Uint8Array[] = []
  const written = {byteLength: 0}
  const output: ProjectTransferZipOutput = {
    getByteLength: () => {
      return written.byteLength
    },
    writeBytes: async (bytes) => {
      archiveHash.update(bytes)
      chunks.push(bytes)
      written.byteLength += bytes.byteLength
    },
  }
  const writtenEntries = await writeProjectTransferZipContentToOutput(entries, output)
  const bytes = new Uint8Array(
    Buffer.concat(
      chunks.map((chunk) => {
        return Buffer.from(chunk)
      }),
      written.byteLength,
    ),
  )

  return {
    bytes,
    checksumSha256: archiveHash.digest('hex'),
    entries: writtenEntries,
    uncompressedSize: writtenEntries.reduce((totalSize, entry) => {
      return totalSize + entry.uncompressedSize
    }, 0),
  }
}

const writeProjectTransferZipPackageWithModule = async ({
  entries,
  zipModule,
}: ProjectTransferZipWriteOptions & {
  zipModule: ProjectTransferZipJsModule
}): Promise<ProjectTransferZipWrittenPackage> => {
  const zipWriter = new zipModule.ZipWriter(new zipModule.Uint8ArrayWriter(), {
    keepOrder: true,
    supportZip64SplitFile: true,
    useWebWorkers: false,
  })
  const writtenEntries = await writeProjectTransferZipEntries(zipWriter, zipModule, entries)
  const bytes = await zipWriter.close({zip64: true})

  return {
    bytes,
    checksumSha256: getSha256Digest(bytes),
    entries: writtenEntries,
    uncompressedSize: writtenEntries.reduce((totalSize, entry) => {
      return totalSize + entry.uncompressedSize
    }, 0),
  }
}

const findProjectTransferZipEndOfCentralDirectoryOffset = (bytes: Uint8Array) => {
  const view = getProjectTransferZipView(bytes)
  const lastOffset = bytes.byteLength - zipEndOfCentralDirectoryLength

  if (lastOffset < 0) {
    return null
  }

  const searchStart = Math.max(
    0,
    bytes.byteLength - zipEndOfCentralDirectoryLength - zipEndOfCentralDirectoryMaxCommentLength,
  )

  return Array.from({length: lastOffset - searchStart + 1}).reduce<number | null>((foundOffset, _, index) => {
    if (foundOffset !== null) {
      return foundOffset
    }

    const offset = lastOffset - index
    const signature = view.getUint32(offset, true)
    const commentLength = signature === zipEndOfCentralDirectorySignature ? view.getUint16(offset + 20, true) : -1

    return signature === zipEndOfCentralDirectorySignature
      && offset + zipEndOfCentralDirectoryLength + commentLength === bytes.byteLength
      ? offset
      : null
  }, null)
}

const assertProjectTransferZipSingleDisk = ({
  centralDirectoryDisk,
  diskEntryCount,
  diskNumber,
  entryCount,
}: {
  centralDirectoryDisk: number
  diskEntryCount: number
  diskNumber: number
  entryCount: number
}) => {
  return diskNumber === 0 && centralDirectoryDisk === 0 && diskEntryCount === entryCount
    ? undefined
    : throwProjectTransferZipError('multi_disk_archive', 'Multi-disk ZIP archives are not supported')
}

const readProjectTransferZip32End = (view: DataView, endOffset: number): ProjectTransferZipEnd => {
  const diskNumber = getProjectTransferZipUint16(view, endOffset + 4, 'ZIP disk number')
  const centralDirectoryDisk = getProjectTransferZipUint16(view, endOffset + 6, 'ZIP central directory disk')
  const diskEntryCount = getProjectTransferZipUint16(view, endOffset + 8, 'ZIP disk entry count')
  const entryCount = getProjectTransferZipUint16(view, endOffset + 10, 'ZIP entry count')

  assertProjectTransferZipSingleDisk({centralDirectoryDisk, diskEntryCount, diskNumber, entryCount})

  return {
    centralDirectoryOffset: getProjectTransferZipUint32(view, endOffset + 16, 'ZIP central directory offset'),
    centralDirectorySize: getProjectTransferZipUint32(view, endOffset + 12, 'ZIP central directory size'),
    entryCount,
  }
}

const readProjectTransferZip64End = (view: DataView, endOffset: number): ProjectTransferZipEnd => {
  const locatorOffset = endOffset - zip64EndOfCentralDirectoryLocatorLength

  assertProjectTransferZipViewRange(view, locatorOffset, zip64EndOfCentralDirectoryLocatorLength, 'ZIP64 locator')

  const locatorSignature = getProjectTransferZipUint32(view, locatorOffset, 'ZIP64 locator signature')

  if (locatorSignature !== zip64EndOfCentralDirectoryLocatorSignature) {
    return throwProjectTransferZipError('missing_zip64_end', 'ZIP64 end locator is missing')
  }

  const locatorDisk = getProjectTransferZipUint32(view, locatorOffset + 4, 'ZIP64 locator disk')
  const zip64EndOffset = getProjectTransferZipUint64(view, locatorOffset + 8, 'ZIP64 end offset')
  const locatorDiskCount = getProjectTransferZipUint32(view, locatorOffset + 16, 'ZIP64 locator disk count')

  if (locatorDisk !== 0 || locatorDiskCount !== 1) {
    return throwProjectTransferZipError('multi_disk_archive', 'Multi-disk ZIP64 archives are not supported')
  }

  const signature = getProjectTransferZipUint32(view, zip64EndOffset, 'ZIP64 end signature')

  if (signature !== zip64EndOfCentralDirectorySignature) {
    return throwProjectTransferZipError('missing_zip64_end', 'ZIP64 end record is missing')
  }

  const recordSize = getProjectTransferZipUint64(view, zip64EndOffset + 4, 'ZIP64 end record size')

  if (recordSize < 44) {
    return throwProjectTransferZipError('malformed_zip64_end', 'ZIP64 end record is too small')
  }

  const diskNumber = getProjectTransferZipUint32(view, zip64EndOffset + 16, 'ZIP64 disk number')
  const centralDirectoryDisk = getProjectTransferZipUint32(view, zip64EndOffset + 20, 'ZIP64 central directory disk')
  const diskEntryCount = getProjectTransferZipUint64(view, zip64EndOffset + 24, 'ZIP64 disk entry count')
  const entryCount = getProjectTransferZipUint64(view, zip64EndOffset + 32, 'ZIP64 entry count')

  assertProjectTransferZipSingleDisk({centralDirectoryDisk, diskEntryCount, diskNumber, entryCount})

  return {
    centralDirectoryOffset: getProjectTransferZipUint64(view, zip64EndOffset + 48, 'ZIP64 central directory offset'),
    centralDirectorySize: getProjectTransferZipUint64(view, zip64EndOffset + 40, 'ZIP64 central directory size'),
    entryCount,
  }
}

const readProjectTransferZipEnd = (bytes: Uint8Array): ProjectTransferZipEnd => {
  const view = getProjectTransferZipView(bytes)
  const endOffset = findProjectTransferZipEndOfCentralDirectoryOffset(bytes)

  if (endOffset === null) {
    return throwProjectTransferZipError('missing_end', 'End of central directory record is missing')
  }

  const zip32End = readProjectTransferZip32End(view, endOffset)
  const locatorOffset = endOffset - zip64EndOfCentralDirectoryLocatorLength
  const hasZip64Locator =
    locatorOffset >= 0
    && getProjectTransferZipUint32(view, locatorOffset, 'ZIP64 locator candidate')
      === zip64EndOfCentralDirectoryLocatorSignature
  const hasZip64Sentinel =
    zip32End.entryCount === zipUint16Max
    || zip32End.centralDirectoryOffset === zipUint32Max
    || zip32End.centralDirectorySize === zipUint32Max

  return hasZip64Locator || hasZip64Sentinel ? readProjectTransferZip64End(view, endOffset) : zip32End
}

const getProjectTransferZipExtraFields = (extraField: Uint8Array) => {
  const view = getProjectTransferZipView(extraField)
  const readFields = (
    offset: number,
    fields: Array<{data: Uint8Array; headerId: number}>,
  ): Array<{data: Uint8Array; headerId: number}> => {
    if (offset === extraField.byteLength) {
      return fields
    }

    assertProjectTransferZipViewRange(view, offset, 4, 'ZIP extra field header')

    const headerId = getProjectTransferZipUint16(view, offset, 'ZIP extra field id')
    const size = getProjectTransferZipUint16(view, offset + 2, 'ZIP extra field size')
    const dataOffset = offset + 4
    const data = getProjectTransferZipBytesSlice(extraField, dataOffset, size, 'ZIP extra field data')

    return readFields(dataOffset + size, [...fields, {data, headerId}])
  }

  return readFields(0, [])
}

const getProjectTransferZipExtraField = (extraField: Uint8Array, headerId: number) => {
  return (
    getProjectTransferZipExtraFields(extraField).find((field) => {
      return field.headerId === headerId
    })?.data ?? null
  )
}

const getProjectTransferZip64CentralDirectoryValues = ({
  compressedSize,
  extraField,
  localHeaderOffset,
  uncompressedSize,
}: {
  compressedSize: number
  extraField: Uint8Array
  localHeaderOffset: number
  uncompressedSize: number
}) => {
  const zip64 =
    compressedSize === zipUint32Max || uncompressedSize === zipUint32Max || localHeaderOffset === zipUint32Max
  const zip64ExtraField = zip64 ? getProjectTransferZipExtraField(extraField, zip64ExtraFieldHeaderId) : null

  if (zip64 && zip64ExtraField === null) {
    return throwProjectTransferZipError('missing_zip64_extra_field', 'ZIP64 central directory extra field is missing')
  }

  const view = zip64ExtraField === null ? null : getProjectTransferZipView(zip64ExtraField)
  const readValue = (state: {offset: number}, value: number, context: string) => {
    if (value !== zipUint32Max) {
      return {...state, value}
    }

    if (view === null) {
      return throwProjectTransferZipError('missing_zip64_extra_field', 'ZIP64 central directory extra field is missing')
    }

    return {offset: state.offset + 8, value: getProjectTransferZipUint64(view, state.offset, context)}
  }
  const uncompressed = readValue({offset: 0}, uncompressedSize, 'ZIP64 uncompressed size')
  const compressed = readValue({offset: uncompressed.offset}, compressedSize, 'ZIP64 compressed size')
  const localHeader = readValue({offset: compressed.offset}, localHeaderOffset, 'ZIP64 local header offset')

  return {
    compressedSize: compressed.value,
    localHeaderOffset: localHeader.value,
    uncompressedSize: uncompressed.value,
    zip64,
  }
}

const readProjectTransferZipCentralDirectoryEntry = (
  bytes: Uint8Array,
  offset: number,
): {entry: ProjectTransferZipCentralDirectoryEntry; nextOffset: number} => {
  const view = getProjectTransferZipView(bytes)
  const signature = getProjectTransferZipUint32(view, offset, 'ZIP central directory header signature')

  if (signature !== zipCentralDirectoryHeaderSignature) {
    return throwProjectTransferZipError('malformed_central_directory', 'Central directory file header is missing')
  }

  assertProjectTransferZipViewRange(view, offset, 46, 'ZIP central directory header')

  const flags = getProjectTransferZipUint16(view, offset + 8, 'ZIP central directory flags')

  if ((flags & zipEncryptedFlag) !== 0) {
    return throwProjectTransferZipError('encrypted_entry', 'Encrypted ZIP entries are not supported')
  }

  const compressionMethod = getProjectTransferZipUint16(view, offset + 10, 'ZIP central directory compression method')
  const entrySignature = getProjectTransferZipUint32(view, offset + 16, 'ZIP central directory CRC32')
  const compressedSize = getProjectTransferZipUint32(view, offset + 20, 'ZIP central directory compressed size')
  const uncompressedSize = getProjectTransferZipUint32(view, offset + 24, 'ZIP central directory uncompressed size')
  const filenameLength = getProjectTransferZipUint16(view, offset + 28, 'ZIP central directory filename length')
  const extraFieldLength = getProjectTransferZipUint16(view, offset + 30, 'ZIP central directory extra field length')
  const commentLength = getProjectTransferZipUint16(view, offset + 32, 'ZIP central directory comment length')
  const externalFileAttributes = getProjectTransferZipUint32(view, offset + 38, 'ZIP central directory attributes')
  const localHeaderOffset = getProjectTransferZipUint32(view, offset + 42, 'ZIP central directory local header offset')
  const filenameOffset = offset + 46
  const extraFieldOffset = filenameOffset + filenameLength
  const commentOffset = extraFieldOffset + extraFieldLength
  const nextOffset = commentOffset + commentLength
  const filenameBytes = getProjectTransferZipBytesSlice(
    bytes,
    filenameOffset,
    filenameLength,
    'ZIP central directory filename',
  )
  const extraField = getProjectTransferZipBytesSlice(
    bytes,
    extraFieldOffset,
    extraFieldLength,
    'ZIP central directory extra field',
  )
  const zip64Values = getProjectTransferZip64CentralDirectoryValues({
    compressedSize,
    extraField,
    localHeaderOffset,
    uncompressedSize,
  })

  assertProjectTransferZipRange({
    byteLength: bytes.byteLength,
    context: 'ZIP central directory comment',
    offset: commentOffset,
    size: commentLength,
  })

  return {
    entry: {
      compressedSize: zip64Values.compressedSize,
      compressionMethod,
      externalFileAttributes,
      localHeaderOffset: zip64Values.localHeaderOffset,
      path: projectTransferZipTextDecoder.decode(filenameBytes),
      signature: entrySignature,
      uncompressedSize: zip64Values.uncompressedSize,
      unixMode: externalFileAttributes >>> 16,
      zip64: zip64Values.zip64,
    },
    nextOffset,
  }
}

const readProjectTransferZipCentralDirectoryEntries = (
  bytes: Uint8Array,
  zipEnd: ProjectTransferZipEnd,
): ProjectTransferZipCentralDirectoryEntry[] => {
  assertProjectTransferZipRange({
    byteLength: bytes.byteLength,
    context: 'ZIP central directory',
    offset: zipEnd.centralDirectoryOffset,
    size: zipEnd.centralDirectorySize,
  })

  const result = Array.from({length: zipEnd.entryCount}).reduce<{
    entries: ProjectTransferZipCentralDirectoryEntry[]
    offset: number
  }>(
    (state) => {
      const {entry, nextOffset} = readProjectTransferZipCentralDirectoryEntry(bytes, state.offset)

      return {entries: [...state.entries, entry], offset: nextOffset}
    },
    {entries: [], offset: zipEnd.centralDirectoryOffset},
  )
  const expectedEnd = zipEnd.centralDirectoryOffset + zipEnd.centralDirectorySize

  return result.offset === expectedEnd
    ? result.entries
    : throwProjectTransferZipError('malformed_central_directory', 'Central directory size does not match entries')
}

const isProjectTransferZipCentralDirectoryEntryDirectory = (entry: ProjectTransferZipCentralDirectoryEntry) => {
  return (
    entry.path.endsWith('/')
    || (entry.unixMode !== null && (entry.unixMode & unixFileTypeMask) === unixDirectoryFileType)
  )
}

const toProjectTransferZipJsEntry = (
  bytes: Uint8Array,
  entry: ProjectTransferZipCentralDirectoryEntry,
): ProjectTransferZipJsEntry => {
  return {
    compressedSize: entry.compressedSize,
    directory: isProjectTransferZipCentralDirectoryEntryDirectory(entry),
    externalFileAttributes: entry.externalFileAttributes,
    filename: entry.path,
    getData: async () => {
      return readProjectTransferZipCentralDirectoryEntryBytes(bytes, entry)
    },
    signature: entry.signature,
    uncompressedSize: entry.uncompressedSize,
    unixMode: entry.unixMode ?? undefined,
    zip64: entry.zip64,
  }
}

const inflateProjectTransferZipEntryBytes = (
  compressedBytes: Uint8Array,
  entry: ProjectTransferZipCentralDirectoryEntry,
) => {
  if (entry.compressionMethod === zipStoreCompressionMethod) {
    return compressedBytes
  }

  if (entry.compressionMethod !== zipDeflateCompressionMethod) {
    return throwProjectTransferZipError(
      'unsupported_compression',
      `Unsupported ZIP compression method ${String(entry.compressionMethod)} for ${entry.path}`,
    )
  }

  try {
    return new Uint8Array(inflateRawSync(compressedBytes))
  } catch (error) {
    return throwProjectTransferZipError(
      'deflate_entry',
      `Failed to inflate ${entry.path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

const readProjectTransferZipCentralDirectoryEntryBytes = (
  bytes: Uint8Array,
  entry: ProjectTransferZipCentralDirectoryEntry,
) => {
  const view = getProjectTransferZipView(bytes)
  const signature = getProjectTransferZipUint32(view, entry.localHeaderOffset, 'ZIP local file header signature')

  if (signature !== zipLocalFileHeaderSignature) {
    return throwProjectTransferZipError('malformed_local_header', `Local file header is missing for ${entry.path}`)
  }

  assertProjectTransferZipViewRange(view, entry.localHeaderOffset, 30, 'ZIP local file header')

  const filenameLength = getProjectTransferZipUint16(view, entry.localHeaderOffset + 26, 'ZIP local filename length')
  const extraFieldLength = getProjectTransferZipUint16(
    view,
    entry.localHeaderOffset + 28,
    'ZIP local extra field length',
  )
  const dataOffset = entry.localHeaderOffset + 30 + filenameLength + extraFieldLength
  const compressedBytes = getProjectTransferZipBytesSlice(bytes, dataOffset, entry.compressedSize, entry.path)
  const entryBytes = inflateProjectTransferZipEntryBytes(compressedBytes, entry)

  if (entryBytes.byteLength !== entry.uncompressedSize) {
    return throwProjectTransferZipError('size_mismatch', `Uncompressed size does not match metadata for ${entry.path}`)
  }

  if (getProjectTransferZipCrc32Digest(entryBytes) !== entry.signature) {
    return throwProjectTransferZipError('crc32_mismatch', `CRC32 does not match metadata for ${entry.path}`)
  }

  return entryBytes
}

const readProjectTransferZipEntryFromCentralDirectoryEntry = (
  bytes: Uint8Array,
  entry: ProjectTransferZipCentralDirectoryEntry,
): ProjectTransferZipReadEntry => {
  const entryBytes = readProjectTransferZipCentralDirectoryEntryBytes(bytes, entry)

  return {
    advisoryCompressedSize: entry.compressedSize,
    advisoryCrc32: entry.signature,
    advisoryUncompressedSize: entry.uncompressedSize,
    bytes: entryBytes,
    checksumSha256: getSha256Digest(entryBytes),
    compressedSize: entry.compressedSize,
    path: entry.path,
    uncompressedSize: entryBytes.byteLength,
    zip64: entry.zip64,
  }
}

const readProjectTransferStoredZipPackage = async ({
  beforeReadEntries,
  bytes,
}: ProjectTransferZipReadOptions): Promise<ProjectTransferZipReadPackage> => {
  const zipEnd = readProjectTransferZipEnd(bytes)
  const centralDirectoryEntries = readProjectTransferZipCentralDirectoryEntries(bytes, zipEnd)
  const zipEntries = centralDirectoryEntries.map((entry) => {
    return toProjectTransferZipJsEntry(bytes, entry)
  })

  assertProjectTransferZipPaths(
    zipEntries.map((entry) => {
      return entry.filename
    }),
  )
  assertProjectTransferZipEntryMetadata(zipEntries)
  assertProjectTransferZipHasManifest(
    zipEntries.map((entry) => {
      return {path: entry.filename}
    }),
  )
  beforeReadEntries?.(zipEntries)

  const entries = centralDirectoryEntries.map((entry) => {
    return readProjectTransferZipEntryFromCentralDirectoryEntry(bytes, entry)
  })
  const manifest = assertProjectTransferZipHasManifest(entries)

  return {entries, manifest}
}

const readProjectTransferZipPackageWithModule = async ({
  beforeReadEntries,
  bytes,
  zipModule,
}: ProjectTransferZipReadOptions & {zipModule: ProjectTransferZipJsModule}): Promise<ProjectTransferZipReadPackage> => {
  const zipReader = new zipModule.ZipReader(new zipModule.Uint8ArrayReader(bytes), {
    checkSignature: true,
    useWebWorkers: false,
  })

  try {
    const zipEntries = await zipReader.getEntries()
    assertProjectTransferZipPaths(
      zipEntries.map((entry) => {
        return entry.filename
      }),
    )
    assertProjectTransferZipEntryMetadata(zipEntries)
    assertProjectTransferZipHasManifest(
      zipEntries.map((entry) => {
        return {path: entry.filename}
      }),
    )
    beforeReadEntries?.(zipEntries)

    const entries = await Promise.all(
      zipEntries.map((entry) => {
        return readProjectTransferZipEntryData(entry, zipModule)
      }),
    )
    const manifest = assertProjectTransferZipHasManifest(entries)

    return {entries, manifest}
  } finally {
    await zipReader.close()
  }
}

export const readProjectTransferZipPackage = async (
  options: ProjectTransferZipReadOptions,
): Promise<ProjectTransferZipReadPackage> => {
  return options.zipModule
    ? readProjectTransferZipPackageWithModule({...options, zipModule: options.zipModule})
    : readProjectTransferStoredZipPackage(options)
}

export const writeProjectTransferZipPackage = async (
  options: ProjectTransferZipWriteOptions,
): Promise<ProjectTransferZipWrittenPackage> => {
  const {entries, zipModule} = options

  assertProjectTransferZipPaths(
    entries.map((entry) => {
      return entry.path
    }),
  )
  assertProjectTransferZipHasManifest(entries)

  return zipModule
    ? writeProjectTransferZipPackageWithModule({...options, zipModule})
    : writeProjectTransferStoredZipPackage(entries)
}

export const writeProjectTransferZipPackageToFile = async ({
  entries,
  outputPath,
}: ProjectTransferZipWriteToFileOptions): Promise<ProjectTransferZipWrittenFilePackage> => {
  assertProjectTransferZipPaths(
    entries.map((entry) => {
      return entry.path
    }),
  )
  assertProjectTransferZipHasManifest(entries)
  await mkdir(dirname(outputPath), {recursive: true})

  const archiveHash = createHash('sha256')
  const stream = createWriteStream(outputPath)
  const written = {byteLength: 0}
  const output: ProjectTransferZipOutput = {
    getByteLength: () => {
      return written.byteLength
    },
    writeBytes: async (bytes) => {
      archiveHash.update(bytes)
      written.byteLength += bytes.byteLength
      await writeStreamBytes(stream, bytes)
    },
  }

  try {
    const writtenEntries = await writeProjectTransferZipContentToOutput(entries, output)
    await closeWriteStream(stream)

    return {
      byteLength: written.byteLength,
      checksumSha256: archiveHash.digest('hex'),
      entries: writtenEntries,
      uncompressedSize: writtenEntries.reduce((totalSize, entry) => {
        return totalSize + entry.uncompressedSize
      }, 0),
    }
  } catch (error) {
    stream.destroy()
    throw error
  }
}
