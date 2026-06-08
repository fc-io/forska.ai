import {createHash} from 'node:crypto'
import {once} from 'node:events'
import {createWriteStream, type WriteStream} from 'node:fs'
import {mkdir} from 'node:fs/promises'
import {dirname} from 'node:path'

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

export type ProjectTransferZipEntryInput = {bytes: string | Uint8Array; lastModifiedAt?: Date; path: string}

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

type ProjectTransferZipFileEntry = ProjectTransferZipEntryDigest & {
  compressedSize: number
  filenameBytes: Uint8Array
  localHeaderOffset: number
}

const projectTransferManifestPath = 'manifest.json'
const projectTransferZipPackageName = '@zip.js/zip.js'
const projectTransferZipDefaultLastModifiedAt = new Date('1980-01-01T00:00:00.000Z')
const unixFileTypeMask = 0o170000
const unixSymlinkFileType = 0o120000
const zipUtf8Flag = 0x0800
const zipStoreCompressionMethod = 0
const zipVersionMadeBy = 45
const zipVersionNeeded = 45
const zipDosTime = 0
const zipDosDate = 33
const zipUint16Max = 0xffff
const zipUint32Max = 0xffffffff
const zip64ExtraFieldHeaderId = 0x0001

const getProjectTransferZipModule = async () => {
  return import(projectTransferZipPackageName) as Promise<ProjectTransferZipJsModule>
}

const getPathErrorMessage = (error: ProjectTransferPathValidationError) => {
  return error.conflictingPath
    ? `${error.message}: ${error.path} conflicts with ${error.conflictingPath}`
    : `${error.message}: ${error.path}`
}

const throwProjectTransferZipError = (code: string, message: string): never => {
  throw new Error(`Project transfer zip ${code}: ${message}`)
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

const getCrc32Digest = (bytes: Uint8Array) => {
  return (
    (bytes.reduce((crc, byte) => {
      return (crc >>> 8) ^ (crc32Table[(crc ^ byte) & 0xff] ?? 0)
    }, 0xffffffff)
      ^ 0xffffffff)
    >>> 0
  )
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
  const bytes = getBytes(entry.bytes)

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

export const readProjectTransferZipPackage = async ({
  beforeReadEntries,
  bytes,
  zipModule,
}: ProjectTransferZipReadOptions): Promise<ProjectTransferZipReadPackage> => {
  const resolvedZipModule = zipModule ?? (await getProjectTransferZipModule())
  const zipReader = new resolvedZipModule.ZipReader(new resolvedZipModule.Uint8ArrayReader(bytes), {
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
        return readProjectTransferZipEntryData(entry, resolvedZipModule)
      }),
    )
    const manifest = assertProjectTransferZipHasManifest(entries)

    return {entries, manifest}
  } finally {
    await zipReader.close()
  }
}

export const writeProjectTransferZipPackage = async ({
  entries,
  zipModule,
}: ProjectTransferZipWriteOptions): Promise<ProjectTransferZipWrittenPackage> => {
  assertProjectTransferZipPaths(
    entries.map((entry) => {
      return entry.path
    }),
  )
  assertProjectTransferZipHasManifest(entries)

  const resolvedZipModule = zipModule ?? (await getProjectTransferZipModule())
  const zipWriter = new resolvedZipModule.ZipWriter(new resolvedZipModule.Uint8ArrayWriter(), {
    keepOrder: true,
    supportZip64SplitFile: true,
    useWebWorkers: false,
  })
  const writtenEntries = await writeProjectTransferZipEntries(zipWriter, resolvedZipModule, entries)
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
  const writeBytes = async (bytes: Uint8Array) => {
    archiveHash.update(bytes)
    written.byteLength += bytes.byteLength
    await writeStreamBytes(stream, bytes)
  }

  try {
    const writtenEntries = await entries.reduce<Promise<ProjectTransferZipFileEntry[]>>(
      async (previousEntries, entry) => {
        const currentEntries = await previousEntries
        const bytes = getBytes(entry.bytes)
        const filenameBytes = new TextEncoder().encode(entry.path)
        const crc32 = getCrc32Digest(bytes)
        const localHeaderOffset = written.byteLength
        const {extraField, header} = getZipLocalFileHeader({crc32, filenameBytes, size: bytes.byteLength})

        await writeBytes(header)
        await writeBytes(filenameBytes)
        await writeBytes(extraField)
        await writeBytes(bytes)

        return [
          ...currentEntries,
          {
            advisoryCompressedSize: bytes.byteLength,
            advisoryCrc32: crc32,
            advisoryUncompressedSize: bytes.byteLength,
            checksumSha256: getSha256Digest(bytes),
            compressedSize: bytes.byteLength,
            filenameBytes,
            localHeaderOffset,
            path: entry.path,
            uncompressedSize: bytes.byteLength,
            zip64: bytes.byteLength > zipUint32Max || localHeaderOffset > zipUint32Max,
          },
        ]
      },
      Promise.resolve([]),
    )
    const centralDirectoryOffset = written.byteLength

    await writtenEntries.reduce<Promise<void>>(async (previous, entry) => {
      await previous
      const {extraField, header} = getZipCentralDirectoryHeader(entry)
      await writeBytes(header)
      await writeBytes(entry.filenameBytes)
      await writeBytes(extraField)
    }, Promise.resolve())

    const centralDirectorySize = written.byteLength - centralDirectoryOffset
    const zip64 =
      isZip64EndRequired({centralDirectoryOffset, centralDirectorySize, entryCount: writtenEntries.length})
      || writtenEntries.some((entry) => {
        return entry.zip64
      })

    if (zip64) {
      const zip64EndOffset = written.byteLength
      await writeBytes(
        getZip64EndOfCentralDirectory({
          centralDirectoryOffset,
          centralDirectorySize,
          entryCount: writtenEntries.length,
        }),
      )
      await writeBytes(getZip64EndOfCentralDirectoryLocator(zip64EndOffset))
    }

    await writeBytes(
      getZipEndOfCentralDirectory({
        centralDirectoryOffset,
        centralDirectorySize,
        entryCount: writtenEntries.length,
        zip64,
      }),
    )
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
